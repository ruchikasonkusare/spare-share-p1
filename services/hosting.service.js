const crypto = require("crypto");

const Device = require("../models/device.model");
const Server = require("../models/server.model");
const DeviceServer = require("../models/deviceServer.model");
const ServerEndpoint = require("../models/serverEndpoint.model");
const MonitoringData = require("../models/monitoringData.model");
const ServerEnvironment = require("../models/serverEnvironment.model");
const Deployment = require("../models/deployment.model");

const {
  DeviceAgentCredential,
  ServerMonitoringState,
  RecoveryCommand,
} = require("../models/hostingRuntime.model");

const { createError } = require("../utils/errors");
const { isObjectId } = require("../utils/validate");
const { allowPrivateDestinations } = require("../utils/network");

const MINUTE = 60 * 1000;

// How long a command may stay unfinished before it is expired.
const COMMAND_TTL_MS = {
  DEPLOY: 45 * MINUTE,
  CREATE_BACKUP: 30 * MINUTE,
  SYNC_ENV: 10 * MINUTE,
  DEFAULT: 5 * MINUTE,
};

// Commands a user may queue directly. DEPLOY and CREATE_BACKUP go through
// their own services because they need a tracked record.
const USER_ACTIONS = [
  "CHECK_APPLICATION",
  "START_APPLICATION",
  "RESTART_APPLICATION",
  "STOP_APPLICATION",
  "CHECK_TUNNEL",
  "RESTART_TUNNEL",
  "REPAIR_TUNNEL",
  "FULL_DIAGNOSTICS",
  "SYNC_ENV",
];

const ACTIVE_COMMAND_STATUSES = ["pending", "sent", "acknowledged", "executing"];
const APPLICATION_STATUSES = ["unknown", "running", "stopped", "starting", "failed"];
const TUNNEL_STATUSES = ["unknown", "connected", "disconnected", "starting", "failed"];

const hashAgentToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const generateAgentToken = () =>
  `ss_agent_${crypto.randomBytes(48).toString("hex")}`;

const safeCompare = (a, b) => {
  const first = Buffer.from(String(a));
  const second = Buffer.from(String(b));
  return first.length === second.length && crypto.timingSafeEqual(first, second);
};

const heartbeatStaleMs = () =>
  Number(process.env.MONITORING_HEARTBEAT_STALE_MS) || 90000;

const isDeviceOnline = (device, now = Date.now()) => {
  if (!device || !device.isActive || !device.lastSeenAt) return false;
  return now - new Date(device.lastSeenAt).getTime() <= heartbeatStaleMs();
};

// ============================================================
// AGENT AUTHENTICATION
// ============================================================

const authenticateAgentToken = async (token) => {
  if (typeof token !== "string" || !/^ss_agent_[a-f0-9]{96}$/.test(token)) {
    throw createError("Invalid device-agent credentials.", 401, "INVALID_AGENT_CREDENTIALS");
  }

  const tokenHash = hashAgentToken(token);

  const credential = await DeviceAgentCredential
    .findOne({ tokenHash, isActive: true })
    .select("+tokenHash");

  if (!credential || !safeCompare(credential.tokenHash, tokenHash)) {
    throw createError(
      "Device-agent credentials are invalid or revoked.",
      401,
      "AGENT_AUTHENTICATION_FAILED"
    );
  }

  const device = await Device.findOne({ _id: credential.deviceId, isActive: true });

  if (!device) {
    throw createError("The registered device is unavailable.", 403, "DEVICE_UNAVAILABLE");
  }

  // Avoid a write on every single agent request.
  const last = credential.lastAuthenticatedAt
    ? new Date(credential.lastAuthenticatedAt).getTime()
    : 0;

  if (Date.now() - last > MINUTE) {
    await DeviceAgentCredential.updateOne(
      { _id: credential._id },
      { $set: { lastAuthenticatedAt: new Date() } }
    );
  }

  return { device, credential };
};

const provisionAgentCredential = async ({ deviceId, userId }) => {
  if (!isObjectId(deviceId) || !isObjectId(userId)) {
    throw createError("Invalid device or user identifier.", 400, "INVALID_IDENTIFIER");
  }

  const device = await Device.findOne({ _id: deviceId, userId, isActive: true });

  if (!device) {
    throw createError("Device not found for this account.", 404, "DEVICE_NOT_FOUND");
  }

  const token = generateAgentToken();

  // Rotating replaces the hash, which immediately invalidates the old token.
  await DeviceAgentCredential.findOneAndUpdate(
    { deviceId: device._id },
    {
      $set: {
        tokenHash: hashAgentToken(token),
        isActive: true,
        revokedAt: null,
        revokedReason: null,
      },
      $inc: { tokenVersion: 1 },
    },
    { upsert: true, new: true, runValidators: true }
  );

  return {
    deviceId: device._id,
    publicDeviceId: device.deviceId,
    agentToken: token,
    tokenType: "Bearer",
  };
};

const revokeAgentCredential = async ({ deviceId, reason = "revoked-by-user" }) => {
  await DeviceAgentCredential.updateOne(
    { deviceId },
    { $set: { isActive: false, revokedAt: new Date(), revokedReason: reason } }
  );
};

// ============================================================
// ASSIGNMENTS
// ============================================================

const assertDeviceServerAssignment = async (deviceId, serverId) => {
  if (!isObjectId(deviceId) || !isObjectId(serverId)) {
    throw createError("Invalid device or server identifier.", 400, "INVALID_DEVICE_SERVER_ID");
  }

  const assignment = await DeviceServer.findOne({
    deviceId,
    serverId,
    status: { $ne: "removed" },
  });

  if (!assignment) {
    throw createError(
      "This device is not assigned to the requested server.",
      403,
      "DEVICE_SERVER_ASSIGNMENT_NOT_FOUND"
    );
  }

  const server = await Server.findOne({ _id: serverId, isActive: true });

  if (!server) {
    throw createError("Server not found or inactive.", 404, "SERVER_NOT_FOUND");
  }

  return { assignment, server };
};

// ============================================================
// TUNNEL URL VALIDATION
// ============================================================

// A device may only register a Cloudflare Quick Tunnel origin. Arbitrary
// destinations from a device would turn the proxy into an open relay.
const validateQuickTunnelUrl = (value) => {
  if (typeof value !== "string" || value.length > 500) {
    throw createError("A valid tunnel URL is required.", 400, "INVALID_TUNNEL_URL");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw createError("Tunnel URL is not a valid URL.", 400, "INVALID_TUNNEL_URL");
  }

  const clean =
    !parsed.username && !parsed.password &&
    parsed.pathname === "/" && !parsed.search && !parsed.hash;

  // Development only: a local agent using TUNNEL_PROVIDER=direct.
  if (
    allowPrivateDestinations() && clean &&
    ["http:", "https:"].includes(parsed.protocol) &&
    ["127.0.0.1", "localhost"].includes(parsed.hostname)
  ) {
    return parsed.origin;
  }

  const hostname = parsed.hostname.toLowerCase();
  const validHostname = hostname.endsWith(".trycloudflare.com");

  if (parsed.protocol !== "https:" || !validHostname || parsed.port || !clean) {
    throw createError(
      "Only HTTPS Cloudflare Quick Tunnel URLs are accepted.",
      400,
      "UNTRUSTED_TUNNEL_URL"
    );
  }

  return parsed.origin;
};

// ============================================================
// TUNNEL REGISTRATION
// ============================================================

const updateTunnelDestination = async ({ device, serverId, tunnelUrl }) => {
  const validatedUrl = validateQuickTunnelUrl(tunnelUrl);
  const { assignment, server } = await assertDeviceServerAssignment(device._id, serverId);

  const { ensureServerEndpoint, buildPermanentLink } = require("./endpoint.service");
  const endpoint = await ensureServerEndpoint(server);

  // First device to bring a tunnel up for a server with no active device
  // becomes the active device.
  let activeDeviceId = server.activeDeviceId;
  if (!activeDeviceId) {
    const claimed = await Server.findOneAndUpdate(
      { _id: server._id, activeDeviceId: null },
      { $set: { activeDeviceId: device._id } },
      { new: true }
    );
    activeDeviceId = claimed ? claimed.activeDeviceId : (await Server.findById(server._id)).activeDeviceId;
  }

  const isActiveDevice = String(activeDeviceId) === String(device._id);

  const index = endpoint.redirectionLinks.findIndex(
    (link) => String(link.deviceId) === String(device._id)
  );

  if (index >= 0) {
    endpoint.redirectionLinks[index].destinationLink = validatedUrl;
    endpoint.redirectionLinks[index].isActive = isActiveDevice;
  } else {
    endpoint.redirectionLinks.push({
      userId: device.userId,
      deviceId: device._id,
      destinationLink: validatedUrl,
      priority: Math.max(1, assignment.priority || 1),
      isActive: isActiveDevice,
    });
  }

  // Only the active device may serve traffic. Prevents a stale primary that
  // comes back online from taking requests after a failover.
  for (const link of endpoint.redirectionLinks) {
    if (String(link.deviceId) !== String(activeDeviceId)) link.isActive = false;
  }

  endpoint.configVersion = Number(endpoint.configVersion || 0) + 1;
  endpoint.routingMode = endpoint.routingMode || "proxy";
  endpoint.lastPublishedAt = new Date();
  await endpoint.save();

  if (isActiveDevice) {
    await ServerMonitoringState.findOneAndUpdate(
      { serverId: server._id },
      {
        $set: {
          deviceId: device._id,
          tunnelUrl: validatedUrl,
          tunnelStatus: "connected",
          lastTunnelAt: new Date(),
          lastError: null,
        },
        $setOnInsert: {
          applicationStatus: "unknown",
          recoveryStatus: "idle",
          consecutiveFailures: 0,
        },
      },
      { upsert: true, new: true, runValidators: true }
    );

    await require("./failover.service").onTunnelRegistered({ server, device });
  }

  return {
    tunnelUrl: validatedUrl,
    isActiveDevice,
    permanentLink: buildPermanentLink(endpoint),
    configVersion: endpoint.configVersion,
  };
};

// ============================================================
// HEARTBEAT
// ============================================================

const clampNumber = (value, min, max) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(value, min), max)
    : undefined;

const SERVER_STATUS_BY_APPLICATION = {
  running: "running",
  starting: "starting",
  stopped: "stopped",
  failed: "failed",
};

const processHeartbeat = async ({ device, payload }) => {
  const now = new Date();
  const wasOffline = device.status !== "online";

  const deviceUpdate = { status: "online", lastSeenAt: now };

  if (typeof payload.agentVersion === "string") {
    deviceUpdate.agentVersion = payload.agentVersion.slice(0, 50);
  }
  if (typeof payload.hostname === "string") {
    deviceUpdate.hostname = payload.hostname.slice(0, 255);
  }

  const metrics = payload.metrics && typeof payload.metrics === "object" ? payload.metrics : null;
  if (metrics) {
    const fields = {
      cpuPercent: clampNumber(metrics.cpuPercent, 0, 100),
      loadAverage: clampNumber(metrics.loadAverage, 0, 10000),
      memoryUsedMb: clampNumber(metrics.memoryUsedMb, 0, 1e9),
      memoryTotalMb: clampNumber(metrics.memoryTotalMb, 0, 1e9),
      diskUsedMb: clampNumber(metrics.diskUsedMb, 0, 1e12),
      diskTotalMb: clampNumber(metrics.diskTotalMb, 0, 1e12),
      batteryPercent: clampNumber(metrics.batteryPercent, 0, 100),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) deviceUpdate[`metrics.${key}`] = value;
    }
    deviceUpdate["metrics.updatedAt"] = now;
  }

  await Device.updateOne({ _id: device._id }, { $set: deviceUpdate });

  if (wasOffline && device.status === "offline") {
    await require("./notification.service").notify({
      userId: device.userId,
      type: "device.online",
      severity: "success",
      title: "Device back online",
      message: `${device.name} reconnected to SpareShare.`,
      deviceId: device._id,
      dedupeKey: `device.online:${device._id}`,
      dedupeWindowMs: 5 * MINUTE,
    });
  }

  const serverReports = Array.isArray(payload.servers) ? payload.servers : [];

  if (serverReports.length > 50) {
    throw createError("Too many server reports in one heartbeat.", 400, "TOO_MANY_SERVER_REPORTS");
  }

  const updatedServers = [];

  for (const report of serverReports) {
    if (!report || !isObjectId(report.serverId)) continue;

    const assignment = await DeviceServer.findOne({
      deviceId: device._id,
      serverId: report.serverId,
      status: { $ne: "removed" },
    });

    // A report for a server that is no longer assigned is ignored rather
    // than failing the whole heartbeat.
    if (!assignment) continue;

    const server = await Server.findOne({ _id: report.serverId, isActive: true });
    if (!server) continue;

    const applicationStatus = APPLICATION_STATUSES.includes(report.applicationStatus)
      ? report.applicationStatus
      : "unknown";

    const tunnelStatus = TUNNEL_STATUSES.includes(report.tunnelStatus)
      ? report.tunnelStatus
      : "unknown";

    const assignmentStatus =
      { running: "running", starting: "starting", stopped: "stopped", failed: "failed" }[applicationStatus];

    if (assignmentStatus && assignment.status !== assignmentStatus) {
      assignment.status = assignmentStatus;
      if (assignmentStatus === "running") assignment.lastStartedAt = now;
      await assignment.save();
    }

    const isActiveDevice = String(server.activeDeviceId) === String(device._id);

    // Only the active device drives the server's public state.
    if (isActiveDevice) {
      await ServerMonitoringState.findOneAndUpdate(
        { serverId: server._id },
        {
          $set: {
            deviceId: device._id,
            applicationStatus,
            tunnelStatus,
            lastHeartbeatAt: now,
            lastError: typeof report.error === "string" ? report.error.slice(0, 1000) : null,
          },
          $setOnInsert: {
            recoveryStatus: "idle",
            consecutiveFailures: 0,
            nextCheckAt: now,
          },
        },
        { upsert: true, new: true, runValidators: true }
      );

      const nextStatus = SERVER_STATUS_BY_APPLICATION[applicationStatus];
      if (nextStatus && server.status !== nextStatus) {
        const statusUpdate = { status: nextStatus };
        if (nextStatus === "running") statusUpdate.startedAt = now;
        if (nextStatus === "stopped" || nextStatus === "failed") statusUpdate.stoppedAt = now;
        await Server.updateOne({ _id: server._id }, { $set: statusUpdate });
      }

      const healthOk = report.health ? report.health.ok !== false : true;
      const health =
        applicationStatus === "running"
          ? (healthOk ? "healthy" : "degraded")
          : applicationStatus === "starting" ? "degraded" : "down";

      const monitoringUpdate = { health, lastHeartbeatAt: now };
      const m = report.metrics && typeof report.metrics === "object" ? report.metrics : {};

      const cpu = clampNumber(m.cpuPercent, 0, 100);
      const memoryMb = clampNumber(m.memoryMb, 0, 1e9);
      const uptime = clampNumber(m.uptimeSeconds, 0, 1e10);
      const totalMb = clampNumber(metrics && metrics.memoryTotalMb, 0, 1e9);

      if (cpu !== undefined) monitoringUpdate["cpu.usagePercent"] = cpu;
      if (uptime !== undefined) monitoringUpdate.uptimeSeconds = uptime;
      if (memoryMb !== undefined) {
        monitoringUpdate["memory.usageMb"] = memoryMb;
        if (totalMb) {
          monitoringUpdate["memory.totalMb"] = totalMb;
          monitoringUpdate["memory.usagePercent"] = Math.min(100, (memoryMb / totalMb) * 100);
        }
      }

      await MonitoringData.updateOne(
        { serverId: server._id },
        { $set: monitoringUpdate, $setOnInsert: { serverId: server._id } },
        { upsert: true, runValidators: true }
      );
    }

    updatedServers.push({
      serverId: report.serverId,
      applicationStatus,
      tunnelStatus,
      isActiveDevice,
    });
  }

  const pendingCommands = await RecoveryCommand.countDocuments({
    deviceId: device._id,
    status: "pending",
    expiresAt: { $gt: now },
  });

  return {
    deviceId: device._id,
    lastSeenAt: now,
    serverTime: now.toISOString(),
    pendingCommands,
    updatedServers,
  };
};

// ============================================================
// DESIRED STATE FOR THE AGENT
// ============================================================

// The agent reconciles toward this configuration on every poll, so a lost
// command never leaves a device permanently out of sync.
const getDeviceConfiguration = async (device) => {
  const assignments = await DeviceServer.find({
    deviceId: device._id,
    status: { $ne: "removed" },
  })
    .populate({ path: "serverId" })
    .lean();

  const servers = [];

  for (const item of assignments) {
    const server = item.serverId;
    if (!server || !server.isActive || server.status === "deleted") continue;

    const [environment, lastDeployment] = await Promise.all([
      ServerEnvironment.findOne({ serverId: server._id }).select("revision").lean(),
      Deployment.findOne({ serverId: server._id, deviceId: device._id, status: "running" })
        .sort({ finishedAt: -1 })
        .select("deploymentId")
        .lean(),
    ]);

    const isActiveDevice = String(server.activeDeviceId) === String(device._id);

    servers.push({
      serverId: server._id,
      name: server.name,
      slug: server.slug,
      status: server.status,
      port: server.port || null,
      monitoringEnabled: server.monitoringEnabled,
      assignmentStatus: item.status,
      role: item.role,
      priority: item.priority,
      isActiveDevice,
      // A standby keeps its copy stopped until it is promoted.
      desiredState: isActiveDevice ? server.desiredState : "stopped",
      healthCheckPath: (server.build && server.build.healthCheckPath) || "/",
      environmentRevision: environment ? environment.revision : 0,
      deploymentId: lastDeployment ? lastDeployment.deploymentId : null,
    });
  }

  return servers;
};

// ============================================================
// COMMAND QUEUE
// ============================================================

const expireCommands = async (filter = {}) => {
  await RecoveryCommand.updateMany(
    { ...filter, status: { $in: ACTIVE_COMMAND_STATUSES }, expiresAt: { $lte: new Date() } },
    { $set: { status: "expired", error: "Command expired before completion." } }
  );
};

const queueCommand = async ({ serverId, deviceId, action, payload = {}, ttlMs, dedupe = false }) => {
  const now = Date.now();

  // Optional de-duplication: do not stack identical commands that have not
  // been picked up yet (retried HTTP requests, repeated monitor cycles).
  if (dedupe) {
    const existing = await RecoveryCommand.findOne({
      serverId,
      deviceId,
      action,
      status: "pending",
      expiresAt: { $gt: new Date(now) },
    });
    if (existing) return existing;
  }

  return RecoveryCommand.create({
    commandId: crypto.randomUUID(),
    serverId,
    deviceId,
    action,
    payload,
    status: "pending",
    expiresAt: new Date(now + (ttlMs || COMMAND_TTL_MS[action] || COMMAND_TTL_MS.DEFAULT)),
  });
};

const getPendingCommands = async (device) => {
  const now = new Date();
  await expireCommands({ deviceId: device._id });

  const pending = await RecoveryCommand.find({
    deviceId: device._id,
    status: "pending",
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: 1 })
    .limit(20);

  const commands = [];

  for (const command of pending) {
    // Atomic claim: two concurrent polls cannot both receive a command.
    const claimed = await RecoveryCommand.findOneAndUpdate(
      { _id: command._id, deviceId: device._id, status: "pending" },
      { $set: { status: "sent" } },
      { new: true }
    );
    if (claimed) commands.push(claimed);
  }

  return commands;
};

const createRecoveryCommand = async ({ userId, serverId, deviceId, action, payload = {} }) => {
  if (!USER_ACTIONS.includes(action)) {
    throw createError("Unsupported recovery command.", 400, "INVALID_RECOVERY_ACTION");
  }

  if (!isObjectId(serverId) || !isObjectId(deviceId)) {
    throw createError("Invalid device or server identifier.", 400, "INVALID_DEVICE_SERVER_ID");
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw createError("Command payload must be an object.", 400, "INVALID_COMMAND_PAYLOAD");
  }

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 8192) {
    throw createError("Command payload is too large.", 400, "COMMAND_PAYLOAD_TOO_LARGE");
  }

  const server = await Server.findOne({ _id: serverId, owner: userId, isActive: true });
  if (!server) {
    throw createError("Server not found or you do not own it.", 404, "SERVER_NOT_FOUND");
  }

  await assertDeviceServerAssignment(deviceId, serverId);

  const device = await Device.findOne({ _id: deviceId, isActive: true });
  if (!device || String(device.userId) !== String(userId)) {
    throw createError("Device is not available to this account.", 403, "DEVICE_ACCESS_DENIED");
  }

  return queueCommand({ serverId, deviceId, action, payload, dedupe: true });
};

const reportCommandResult = async ({ device, commandId, status, result, error }) => {
  if (!["acknowledged", "executing", "completed", "failed"].includes(status)) {
    throw createError("Invalid command result status.", 400, "INVALID_COMMAND_STATUS");
  }

  const command = await RecoveryCommand.findOne({ commandId, deviceId: device._id });

  if (!command) {
    throw createError("Command not found for this device.", 404, "COMMAND_NOT_FOUND");
  }

  if (["completed", "failed", "expired"].includes(command.status)) {
    // A retried report of the same final state is acknowledged, not rejected.
    if (command.status === status) return command;
    throw createError(
      "This command has already reached a final state.",
      409,
      "COMMAND_ALREADY_FINISHED"
    );
  }

  const now = new Date();
  if (status === "acknowledged") command.acknowledgedAt = now;
  if (status === "executing") command.startedAt = command.startedAt || now;
  if (status === "completed" || status === "failed") command.completedAt = now;

  command.status = status;

  if (result !== undefined) {
    const serialized = JSON.stringify(result) || "null";
    command.result = serialized.length > 16384
      ? { truncated: true, preview: serialized.slice(0, 16000) }
      : result;
  }

  if (error !== undefined && error !== null) {
    command.error = String(error).slice(0, 2000);
  }

  await command.save();
  return command;
};

module.exports = {
  createError,
  USER_ACTIONS,
  ACTIVE_COMMAND_STATUSES,
  isDeviceOnline,
  heartbeatStaleMs,
  authenticateAgentToken,
  provisionAgentCredential,
  revokeAgentCredential,
  assertDeviceServerAssignment,
  validateQuickTunnelUrl,
  updateTunnelDestination,
  processHeartbeat,
  getDeviceConfiguration,
  expireCommands,
  queueCommand,
  getPendingCommands,
  createRecoveryCommand,
  reportCommandResult,
};
