const Device = require("../models/device.model");
const Server = require("../models/server.model");
const ServerEndpoint = require("../models/serverEndpoint.model");
const FailoverEvent = require("../models/failoverEvent.model");
const Deployment = require("../models/deployment.model");

const { ServerMonitoringState, RecoveryCommand } = require("../models/hostingRuntime.model");

const {
  validateQuickTunnelUrl,
  assertDeviceServerAssignment,
  queueCommand,
  expireCommands,
  isDeviceOnline,
  heartbeatStaleMs,
  ACTIVE_COMMAND_STATUSES,
} = require("./hosting.service");

const { buildPermanentLink } = require("./endpoint.service");
const { notify } = require("./notification.service");

const MINUTE = 60 * 1000;

const getMonitoringConfig = () => ({
  intervalMs: Number(process.env.MONITORING_INTERVAL_MS) || 30000,
  timeoutMs: Number(process.env.MONITORING_TIMEOUT_MS) || 5000,
  heartbeatStaleMs: heartbeatStaleMs(),
  failureThreshold: Number(process.env.MONITORING_FAILURE_THRESHOLD) || 3,
  recoveryCooldownMs: Number(process.env.MONITORING_RECOVERY_COOLDOWN_MS) || 300000,
  recoveryWindowMs: Number(process.env.MONITORING_RECOVERY_WINDOW_MS) || 1800000,
  maxRecoveryAttempts: Number(process.env.MONITORING_MAX_RECOVERY_ATTEMPTS) || 3,
  batchSize: Number(process.env.MONITORING_BATCH_SIZE) || 10,
  leaseMs: Number(process.env.MONITORING_LEASE_MS) || 60000,
});

// ============================================================
// HTTP HEALTH PROBE
// ============================================================

const probeHttpUrl = async (url, timeoutMs) => {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": "SpareShare-Monitor/1.0" },
    });

    return {
      reachable: true,
      status: response.status,
      healthy: response.status < 500,
      error: null,
    };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      healthy: false,
      error: error.name === "TimeoutError" ? "Health check timed out." : error.message,
    };
  }
};

const classifyMonitoringFailure = ({ deviceIsOnline, endpointProbe, tunnelProbe }) => {
  if (!deviceIsOnline) return "device_unreachable";
  if (!tunnelProbe.reachable) return "tunnel_unreachable";
  if ([502, 503, 504].includes(tunnelProbe.status)) return "tunnel_upstream_error";
  if (tunnelProbe.status >= 500) return "application_http_error";
  if (!endpointProbe.reachable || endpointProbe.status >= 500) return "permanent_endpoint_failure";
  return "none";
};

// ============================================================
// AUTOMATIC RECOVERY
// ============================================================

// Returns "queued", "waiting" or "exhausted".
const queueAutomatedRecoveryCommand = async ({
  state,
  device,
  failureType,
  endpointProbe,
  tunnelProbe,
}) => {
  const now = new Date();
  const config = getMonitoringConfig();

  const activeCommand = await RecoveryCommand.findOne({
    serverId: state.serverId,
    deviceId: device._id,
    status: { $in: ACTIVE_COMMAND_STATUSES },
    expiresAt: { $gt: now },
  });

  if (activeCommand) {
    state.recoveryStatus = "in_progress";
    state.lastRecoveryCommandId = activeCommand.commandId;
    await state.save();
    return "waiting";
  }

  if (state.recoveryCooldownUntil && state.recoveryCooldownUntil > now) {
    state.recoveryStatus = "required";
    await state.save();
    return "waiting";
  }

  const windowExpired =
    !state.recoveryWindowStartedAt ||
    now.getTime() - new Date(state.recoveryWindowStartedAt).getTime() >= config.recoveryWindowMs;

  if (windowExpired) {
    state.recoveryWindowStartedAt = now;
    state.recoveryAttemptCount = 0;
  }

  if (state.recoveryAttemptCount >= config.maxRecoveryAttempts) {
    state.recoveryStatus = "failed";
    state.lastError = "Maximum automatic recovery attempts reached.";
    await state.save();
    return "exhausted";
  }

  let action;

  if (!state.tunnelUrl) {
    action = "REPAIR_TUNNEL";
  } else if (state.applicationStatus === "stopped" || state.applicationStatus === "failed") {
    action = "START_APPLICATION";
  } else if (
    state.tunnelStatus === "disconnected" ||
    state.tunnelStatus === "failed" ||
    failureType === "tunnel_unreachable"
  ) {
    action = "RESTART_TUNNEL";
  } else if (failureType === "tunnel_upstream_error") {
    // The tunnel answers but the app behind it does not.
    action = "RESTART_APPLICATION";
  } else if (failureType === "application_http_error") {
    action = "CHECK_APPLICATION";
  } else if (failureType === "permanent_endpoint_failure") {
    // The device side is healthy; the fault is in routing, not on the device.
    state.recoveryStatus = "required";
    await state.save();
    return "waiting";
  } else {
    action = "FULL_DIAGNOSTICS";
  }

  await assertDeviceServerAssignment(device._id, state.serverId);

  const command = await queueCommand({
    serverId: state.serverId,
    deviceId: device._id,
    action,
    payload: {
      source: "automatic_monitoring",
      failureType,
      consecutiveFailures: state.consecutiveFailures,
      endpointStatus: endpointProbe.status,
      tunnelStatus: tunnelProbe.status,
    },
  });

  state.recoveryAttemptCount += 1;
  state.lastRecoveryAt = now;
  state.recoveryCooldownUntil = new Date(now.getTime() + config.recoveryCooldownMs);
  state.lastRecoveryCommandId = command.commandId;
  state.recoveryStatus = "in_progress";
  await state.save();

  console.log(`[SpareShare Monitor] Queued ${action} for server ${state.serverId}`);
  return "queued";
};

// ============================================================
// PROCESS ONE SERVER
// ============================================================

const processMonitoringState = async (state) => {
  const config = getMonitoringConfig();
  const now = new Date();

  try {
    const [server, device, endpoint] = await Promise.all([
      Server.findOne({ _id: state.serverId, isActive: true }),
      Device.findOne({ _id: state.deviceId, isActive: true }),
      ServerEndpoint.findOne({ serverId: state.serverId, isActive: true }),
    ]);

    if (!server || !server.monitoringEnabled) return;

    // A server the owner stopped is not a failure.
    if (server.desiredState !== "running") {
      if (state.consecutiveFailures > 0 || state.recoveryStatus !== "idle") {
        state.consecutiveFailures = 0;
        state.recoveryStatus = "idle";
        state.lastFailureType = "none";
        state.lastError = null;
        await state.save();
      }
      return;
    }

    // While a failover is deploying the standby, health checks would only
    // report the gap that the failover is already closing.
    if (await FailoverEvent.exists({ serverId: server._id, inProgress: true })) return;

    // A deployment restarts the application on purpose.
    if (await Deployment.exists({ serverId: server._id, deviceId: state.deviceId, isActive: true })) return;

    // The state may still point at a previous device.
    if (server.activeDeviceId && String(server.activeDeviceId) !== String(state.deviceId)) return;

    const deviceIsOnline = isDeviceOnline(device, now.getTime());

    const endpointProbe = endpoint
      ? await probeHttpUrl(buildPermanentLink(endpoint), config.timeoutMs)
      : { reachable: false, status: null, healthy: false, error: "Permanent endpoint is missing." };

    let tunnelProbe = {
      reachable: false,
      status: null,
      healthy: false,
      error: "Tunnel URL is missing.",
    };

    if (state.tunnelUrl) {
      try {
        const tunnelUrl = validateQuickTunnelUrl(state.tunnelUrl);
        tunnelProbe = await probeHttpUrl(`${tunnelUrl}/`, config.timeoutMs);
      } catch (error) {
        tunnelProbe.error = error.message;
      }
    }

    const failureType = classifyMonitoringFailure({ deviceIsOnline, endpointProbe, tunnelProbe });
    const failed = failureType !== "none";
    const wasFailing = state.consecutiveFailures >= config.failureThreshold;

    state.lastHealthCheckAt = now;
    state.lastPublicEndpointStatus = endpointProbe.status;
    state.lastTunnelHttpStatus = tunnelProbe.status;
    state.lastFailureType = failureType;
    state.consecutiveFailures = failed ? state.consecutiveFailures + 1 : 0;

    if (tunnelProbe.reachable && tunnelProbe.status < 500) {
      state.tunnelStatus = "connected";
      state.lastTunnelAt = now;
    }

    if (!failed) {
      state.lastError = null;
      state.recoveryStatus = ["required", "in_progress", "failed"].includes(state.recoveryStatus)
        ? "recovered"
        : "idle";
      state.recoveryAttemptCount = 0;
      state.recoveryWindowStartedAt = null;
      state.recoveryCooldownUntil = null;
    } else {
      state.lastError = [endpointProbe.error, tunnelProbe.error, failureType]
        .filter(Boolean)
        .join(" | ")
        .slice(0, 1000);
    }

    await state.save();

    if (!failed) {
      if (wasFailing) {
        await notify({
          userId: server.owner,
          type: "server.recovered",
          severity: "success",
          title: "Server recovered",
          message: `${server.name} is reachable again.`,
          serverId: server._id,
          deviceId: state.deviceId,
        });
      }
      return;
    }

    console.log(`[SpareShare Monitor] Server ${state.serverId}: ${failureType}`);

    if (state.consecutiveFailures < config.failureThreshold) return;

    if (state.consecutiveFailures === config.failureThreshold) {
      await notify({
        userId: server.owner,
        type: "server.down",
        severity: "critical",
        title: "Server is unreachable",
        message: `${server.name} failed ${config.failureThreshold} health checks in a row (${failureType.replace(/_/g, " ")}).`,
        serverId: server._id,
        deviceId: state.deviceId,
        dedupeKey: `server.down:${server._id}`,
        dedupeWindowMs: 10 * MINUTE,
      });
    }

    const { evaluateFailover } = require("./failover.service");

    // An unreachable device cannot receive a recovery command, so the only
    // remedy is another device.
    if (!deviceIsOnline) {
      state.recoveryStatus = "required";
      state.lastError = "Device is unreachable. Waiting for connectivity or failover.";
      await state.save();
      await evaluateFailover({ server, reason: "The hosting device is offline" });
      return;
    }

    const outcome = await queueAutomatedRecoveryCommand({
      state,
      device,
      failureType,
      endpointProbe,
      tunnelProbe,
    });

    if (outcome === "exhausted") {
      await evaluateFailover({ server, reason: "Automatic recovery did not restore the server" });
    }
  } finally {
    await ServerMonitoringState.updateOne(
      { _id: state._id },
      { $set: { schedulerLeaseUntil: null } }
    );
  }
};

// ============================================================
// MONITORING CYCLE
// ============================================================

let monitoringCycleRunning = false;

const runMonitoringCycle = async () => {
  if (monitoringCycleRunning) return;
  monitoringCycleRunning = true;

  const config = getMonitoringConfig();
  const now = new Date();

  const leaseFree = [
    { schedulerLeaseUntil: null },
    { schedulerLeaseUntil: { $exists: false } },
    { schedulerLeaseUntil: { $lte: now } },
  ];

  try {
    await expireCommands();

    const dueStates = await ServerMonitoringState.find({
      nextCheckAt: { $lte: now },
      $or: leaseFree,
    })
      .select("_id")
      .sort({ nextCheckAt: 1 })
      .limit(config.batchSize)
      .lean();

    const claimedStates = [];

    // Atomic claim with a lease, so several API instances can share the work.
    for (const item of dueStates) {
      const claimed = await ServerMonitoringState.findOneAndUpdate(
        { _id: item._id, nextCheckAt: { $lte: now }, $or: leaseFree },
        {
          $set: {
            schedulerLeaseUntil: new Date(now.getTime() + config.leaseMs),
            nextCheckAt: new Date(now.getTime() + config.intervalMs),
          },
        },
        { new: true }
      );
      if (claimed) claimedStates.push(claimed);
    }

    const results = await Promise.allSettled(
      claimedStates.map((state) => processMonitoringState(state))
    );

    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[SpareShare Monitor] Health check failed:", result.reason);
      }
    }
  } catch (error) {
    console.error("[SpareShare Monitor] Scheduler cycle failed:", error);
  } finally {
    monitoringCycleRunning = false;
  }
};

// Devices that stopped sending heartbeats are marked offline exactly once.
const markOfflineDevices = async () => {
  const cutoff = new Date(Date.now() - heartbeatStaleMs());

  const silent = await Device.find({
    status: "online",
    isActive: true,
    lastSeenAt: { $lt: cutoff },
  })
    .select("_id")
    .limit(100)
    .lean();

  let marked = 0;

  for (const item of silent) {
    const device = await Device.findOneAndUpdate(
      { _id: item._id, status: "online", lastSeenAt: { $lt: cutoff } },
      { $set: { status: "offline" } },
      { new: true }
    );

    if (!device) continue;
    marked += 1;

    const hosting = await Server.countDocuments({
      activeDeviceId: device._id,
      isActive: true,
      desiredState: "running",
    });

    await notify({
      userId: device.userId,
      type: "device.offline",
      severity: hosting > 0 ? "critical" : "warning",
      title: "Device went offline",
      message:
        hosting > 0
          ? `${device.name} stopped responding. It hosts ${hosting} running server${hosting === 1 ? "" : "s"}.`
          : `${device.name} stopped responding.`,
      deviceId: device._id,
      dedupeKey: `device.offline:${device._id}`,
      dedupeWindowMs: 10 * MINUTE,
    });
  }

  return marked;
};

module.exports = {
  getMonitoringConfig,
  probeHttpUrl,
  classifyMonitoringFailure,
  runMonitoringCycle,
  markOfflineDevices,
};
