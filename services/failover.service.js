const Server = require("../models/server.model");
const Device = require("../models/device.model");
const DeviceServer = require("../models/deviceServer.model");
const ServerEndpoint = require("../models/serverEndpoint.model");
const Deployment = require("../models/deployment.model");
const Backup = require("../models/backup.model");
const FailoverEvent = require("../models/failoverEvent.model");

const { ServerMonitoringState, RecoveryCommand } = require("../models/hostingRuntime.model");

const { createError } = require("../utils/errors");
const { isObjectId } = require("../utils/validate");
const { notify } = require("./notification.service");

const MINUTE = 60 * 1000;

const failoverGraceMs = () => Number(process.env.FAILOVER_GRACE_MS) || 3 * MINUTE;
const failoverTimeoutMs = () => Number(process.env.FAILOVER_TIMEOUT_MS) || 25 * MINUTE;
const failedTargetCooldownMs = () => Number(process.env.FAILOVER_RETRY_COOLDOWN_MS) || 30 * MINUTE;

const finishEvent = async (event, { status, error }) => {
  event.status = status;
  event.inProgress = false;
  event.completedAt = new Date();
  if (error) event.error = String(error).slice(0, 2000);
  await event.save();
};

// Standby devices that could take over, best first.
const findCandidates = async ({ server, excludeDeviceIds = [] }) => {
  const { isDeviceOnline } = require("./hosting.service");
  const excluded = new Set(excludeDeviceIds.map(String));
  if (server.activeDeviceId) excluded.add(String(server.activeDeviceId));

  const assignments = await DeviceServer.find({
    serverId: server._id,
    status: { $ne: "removed" },
  }).sort({ priority: 1, assignedAt: 1 });

  const candidates = [];

  for (const assignment of assignments) {
    if (excluded.has(String(assignment.deviceId))) continue;
    const device = await Device.findOne({
      _id: assignment.deviceId,
      userId: server.owner,
      isActive: true,
    });
    if (device && isDeviceOnline(device)) candidates.push(device);
  }

  return candidates;
};

const chooseStrategy = async (server) => {
  const backup = await Backup.findOne({ serverId: server._id, status: "completed" })
    .sort({ completedAt: -1 });

  if (backup) return { strategy: "backup", backup };
  if (server.repository && server.repository.repositoryUrl) return { strategy: "git" };

  throw createError(
    "There is no backup and no repository to bring this server up on another device.",
    409,
    "NOTHING_TO_FAIL_OVER_WITH"
  );
};

const startFailover = async ({ server, toDevice, reason, trigger, userId = null }) => {
  const fromDeviceId = server.activeDeviceId || null;

  if (fromDeviceId && String(fromDeviceId) === String(toDevice._id)) {
    throw createError("That device is already serving this server.", 409, "ALREADY_ACTIVE_DEVICE");
  }

  const { strategy, backup } = await chooseStrategy(server);

  let event;

  try {
    event = await FailoverEvent.create({
      serverId: server._id,
      fromDeviceId,
      toDeviceId: toDevice._id,
      trigger,
      reason: String(reason || "").slice(0, 500),
      strategy,
      backupId: backup ? backup.backupId : undefined,
      status: "deploying",
      inProgress: true,
    });
  } catch (error) {
    if (error.code === 11000) {
      throw createError("A failover is already in progress for this server.", 409, "FAILOVER_IN_PROGRESS");
    }
    throw error;
  }

  const now = new Date();

  // Compare-and-swap on the active device: if something else moved the
  // server in the meantime this failover stands down.
  const switched = await Server.findOneAndUpdate(
    { _id: server._id, activeDeviceId: fromDeviceId },
    {
      $set: {
        activeDeviceId: toDevice._id,
        desiredState: "running",
        status: "starting",
        "failover.lastFailoverAt": now,
      },
    },
    { new: true }
  );

  if (!switched) {
    await finishEvent(event, { status: "failed", error: "The active device changed during failover." });
    throw createError("The active device changed. Try again.", 409, "FAILOVER_CONFLICT");
  }

  const revert = async (message) => {
    await Server.updateOne(
      { _id: server._id, activeDeviceId: toDevice._id },
      { $set: { activeDeviceId: fromDeviceId } }
    );
    await finishEvent(event, { status: "failed", error: message });
  };

  try {
    // Nothing reaches the old device's tunnel from this point on.
    await ServerEndpoint.updateOne(
      { serverId: server._id },
      { $set: { "redirectionLinks.$[].isActive": false }, $inc: { configVersion: 1 } }
    );

    if (fromDeviceId) {
      await RecoveryCommand.updateMany(
        {
          serverId: server._id,
          deviceId: fromDeviceId,
          status: { $in: ["pending", "sent", "acknowledged", "executing"] },
        },
        { $set: { status: "expired", error: "Superseded by failover." } }
      );
      await Deployment.updateMany(
        { serverId: server._id, deviceId: fromDeviceId, isActive: true },
        { $set: { status: "cancelled", isActive: false, finishedAt: now, error: "Superseded by failover." } }
      );
      await DeviceServer.updateOne(
        { serverId: server._id, deviceId: fromDeviceId },
        { $set: { role: "standby" } }
      );
    }

    await DeviceServer.updateOne(
      { serverId: server._id, deviceId: toDevice._id },
      { $set: { role: "primary" } }
    );

    // Give the new device time to deploy before health checks count.
    await ServerMonitoringState.findOneAndUpdate(
      { serverId: server._id },
      {
        $set: {
          deviceId: toDevice._id,
          tunnelUrl: null,
          tunnelStatus: "starting",
          applicationStatus: "starting",
          consecutiveFailures: 0,
          lastFailureType: "none",
          recoveryStatus: "idle",
          recoveryAttemptCount: 0,
          recoveryWindowStartedAt: null,
          recoveryCooldownUntil: null,
          lastError: null,
          schedulerLeaseUntil: null,
          nextCheckAt: new Date(now.getTime() + failoverGraceMs()),
        },
      },
      { upsert: true, new: true }
    );

    const { createDeployment } = require("./deployment.service");
    let result;

    if (strategy === "backup") {
      result = await createDeployment({
        server: switched,
        userId,
        deviceId: toDevice._id,
        trigger: "failover",
        source: { type: "backup", backupId: backup.backupId, commitSha: backup.commitSha },
      });
    } else {
      const last = await Deployment.findOne({
        serverId: server._id,
        status: { $in: ["running", "superseded"] },
        "source.type": "git",
      }).sort({ finishedAt: -1 });

      result = await createDeployment({
        server: switched,
        userId,
        deviceId: toDevice._id,
        trigger: "failover",
        branch: last ? last.source.branch : undefined,
        commitSha: last ? last.source.commitSha : undefined,
      });
    }

    event.deploymentId = result.deployment.deploymentId;
    await event.save();
  } catch (error) {
    await revert(error.message);
    throw error;
  }

  await notify({
    userId: server.owner,
    type: "failover.started",
    severity: "critical",
    title: "Failover started",
    message: `${server.name} is being moved to ${toDevice.name}. Reason: ${reason || "requested"}.`,
    serverId: server._id,
    deviceId: toDevice._id,
    data: { failoverEventId: event._id, strategy },
  });

  console.log(`[SpareShare Failover] ${server._id} -> ${toDevice._id} (${strategy}, ${trigger})`);

  return event;
};

// Called by the monitor when the active device is unreachable or automatic
// recovery has been exhausted.
const evaluateFailover = async ({ server, reason }) => {
  if (!server.failover || server.failover.enabled === false) return null;
  if (server.desiredState !== "running") return null;

  if (await FailoverEvent.exists({ serverId: server._id, inProgress: true })) return null;

  // Do not bounce straight back to a device that just failed to take over.
  const recentFailures = await FailoverEvent.find({
    serverId: server._id,
    status: "failed",
    completedAt: { $gt: new Date(Date.now() - failedTargetCooldownMs()) },
  }).select("toDeviceId");

  const candidates = await findCandidates({
    server,
    excludeDeviceIds: recentFailures.map((item) => item.toDeviceId),
  });

  if (candidates.length === 0) {
    await notify({
      userId: server.owner,
      type: "failover.unavailable",
      severity: "critical",
      title: "Server is down and no standby is available",
      message: `${server.name} is unreachable (${reason}). Assign another online device to enable automatic failover.`,
      serverId: server._id,
      dedupeKey: `failover.unavailable:${server._id}`,
      dedupeWindowMs: 30 * MINUTE,
    });
    return null;
  }

  try {
    return await startFailover({ server, toDevice: candidates[0], reason, trigger: "automatic" });
  } catch (error) {
    console.error(`[SpareShare Failover] Could not start failover for ${server._id}: ${error.message}`);
    return null;
  }
};

const manualFailover = async ({ server, userId, targetDeviceId }) => {
  if (!isObjectId(targetDeviceId)) {
    throw createError("A valid target device is required.", 400, "INVALID_DEVICE_ID");
  }

  const assignment = await DeviceServer.findOne({
    serverId: server._id,
    deviceId: targetDeviceId,
    status: { $ne: "removed" },
  });

  if (!assignment) {
    throw createError("That device is not assigned to this server.", 409, "DEVICE_SERVER_ASSIGNMENT_NOT_FOUND");
  }

  const device = await Device.findOne({ _id: targetDeviceId, userId, isActive: true });

  if (!device) {
    throw createError("Device not found for this account.", 404, "DEVICE_NOT_FOUND");
  }

  const { isDeviceOnline } = require("./hosting.service");

  if (!isDeviceOnline(device)) {
    throw createError(`${device.name} is offline and cannot take over.`, 409, "DEVICE_OFFLINE");
  }

  return startFailover({
    server,
    toDevice: device,
    reason: "Requested by the owner",
    trigger: "manual",
    userId,
  });
};

// A failover is complete when the new device has both a running
// deployment and a registered tunnel.
const tryComplete = async (event, server) => {
  const deployment = event.deploymentId
    ? await Deployment.findOne({ deploymentId: event.deploymentId })
    : null;

  if (!deployment || deployment.status !== "running") return false;

  const state = await ServerMonitoringState.findOne({ serverId: event.serverId });
  const tunnelReady =
    state && state.tunnelUrl && String(state.deviceId) === String(event.toDeviceId);

  if (!tunnelReady) {
    if (event.status !== "awaiting_tunnel") {
      event.status = "awaiting_tunnel";
      await event.save();
    }
    return false;
  }

  await finishEvent(event, { status: "completed" });

  const device = await Device.findById(event.toDeviceId).select("name");

  await notify({
    userId: server.owner,
    type: "failover.completed",
    severity: "success",
    title: "Failover completed",
    message: `${server.name} is now served from ${device ? device.name : "the standby device"}.`,
    serverId: server._id,
    deviceId: event.toDeviceId,
    data: { failoverEventId: event._id },
  });

  return true;
};

const onDeploymentFinished = async ({ deployment, server }) => {
  const event = await FailoverEvent.findOne({
    serverId: deployment.serverId,
    deploymentId: deployment.deploymentId,
    inProgress: true,
  });

  if (!event) return;

  if (deployment.status === "running") {
    await tryComplete(event, server);
    return;
  }

  await finishEvent(event, {
    status: "failed",
    error: deployment.error || `Deployment ended with status ${deployment.status}.`,
  });

  await notify({
    userId: server.owner,
    type: "failover.failed",
    severity: "critical",
    title: "Failover failed",
    message: `${server.name} could not be started on the standby device: ${event.error}`.slice(0, 1000),
    serverId: server._id,
    deviceId: event.toDeviceId,
    data: { failoverEventId: event._id },
  });
};

const onTunnelRegistered = async ({ server, device }) => {
  const event = await FailoverEvent.findOne({
    serverId: server._id,
    toDeviceId: device._id,
    inProgress: true,
  });

  if (event) await tryComplete(event, server);
};

const failStaleFailovers = async () => {
  const stale = await FailoverEvent.find({
    inProgress: true,
    startedAt: { $lt: new Date(Date.now() - failoverTimeoutMs()) },
  }).limit(50);

  for (const event of stale) {
    await finishEvent(event, { status: "failed", error: "Failover timed out." });
    const server = await Server.findById(event.serverId);
    if (server) {
      await notify({
        userId: server.owner,
        type: "failover.failed",
        severity: "critical",
        title: "Failover timed out",
        message: `${server.name} did not come up on the standby device in time.`,
        serverId: server._id,
        deviceId: event.toDeviceId,
      });
    }
  }

  return stale.length;
};

const listFailoverEvents = async ({ serverId, limit = 20 }) =>
  FailoverEvent.find({ serverId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("fromDeviceId", "name deviceId")
    .populate("toDeviceId", "name deviceId")
    .lean();

module.exports = {
  findCandidates,
  startFailover,
  evaluateFailover,
  manualFailover,
  onDeploymentFinished,
  onTunnelRegistered,
  failStaleFailovers,
  listFailoverEvents,
};
