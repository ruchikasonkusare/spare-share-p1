const Server = require("../models/server.model");
const Device = require("../models/device.model");
const DeviceServer = require("../models/deviceServer.model");
const MonitoringData = require("../models/monitoringData.model");
const Deployment = require("../models/deployment.model");
const Backup = require("../models/backup.model");
const Notification = require("../models/notification.model");
const ServerEndpoint = require("../models/serverEndpoint.model");

const { ServerMonitoringState } = require("../models/hostingRuntime.model");

const { createError } = require("../utils/errors");
const { readInt, readEnum, readBoolean, isObjectId } = require("../utils/validate");

const { getOwnedServer, findUserDevice } = require("../services/server.service");
const { queueCommand, isDeviceOnline } = require("../services/hosting.service");
const { ensureServerEndpoint, buildPermanentLink } = require("../services/endpoint.service");
const deployments = require("../services/deployment.service");
const backups = require("../services/backup.service");
const failover = require("../services/failover.service");
const { listLogs } = require("../services/log.service");
const { serializeDevice } = require("./device.controller");

const MAX_DEVICES_PER_SERVER = Number(process.env.MAX_DEVICES_PER_SERVER) || 5;

const serializeDeployment = (deployment) => ({
  deploymentId: deployment.deploymentId,
  status: deployment.status,
  trigger: deployment.trigger,
  isActive: deployment.isActive,
  source: {
    type: deployment.source.type,
    fullName: deployment.source.fullName,
    branch: deployment.source.branch,
    commitSha: deployment.source.commitSha,
    backupId: deployment.source.backupId,
  },
  device: deployment.deviceId && deployment.deviceId.name
    ? { id: deployment.deviceId._id, deviceId: deployment.deviceId.deviceId, name: deployment.deviceId.name }
    : { id: deployment.deviceId },
  steps: deployment.steps,
  detection: deployment.detection,
  error: deployment.error || null,
  createdAt: deployment.createdAt,
  startedAt: deployment.startedAt || null,
  finishedAt: deployment.finishedAt || null,
});

// ============================================================
// OVERVIEW
// ============================================================

const getServerOverview = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);

  const [endpoint, state, monitoring, latestDeployment, assignments, lastBackup] = await Promise.all([
    ensureServerEndpoint(server),
    ServerMonitoringState.findOne({ serverId: server._id }).lean(),
    MonitoringData.findOne({ serverId: server._id }).lean(),
    Deployment.findOne({ serverId: server._id })
      .sort({ createdAt: -1 })
      .populate("deviceId", "name deviceId")
      .lean(),
    DeviceServer.find({ serverId: server._id, status: { $ne: "removed" } })
      .sort({ priority: 1 })
      .populate("deviceId")
      .lean(),
    Backup.findOne({ serverId: server._id, status: "completed" })
      .sort({ completedAt: -1 })
      .select("backupId sizeBytes completedAt")
      .lean(),
  ]);

  const traffic = (monitoring && monitoring.traffic) || {};
  const totalRequests = traffic.totalRequests || 0;

  return res.status(200).json({
    success: true,
    data: {
      server,
      permanentUrl: buildPermanentLink(endpoint),
      endpoint: {
        isActive: endpoint.isActive,
        routingMode: endpoint.routingMode,
        security: endpoint.security,
      },
      runtime: {
        applicationStatus: state ? state.applicationStatus : "unknown",
        tunnelStatus: state ? state.tunnelStatus : "unknown",
        tunnelUrl: state ? state.tunnelUrl || null : null,
        lastHeartbeatAt: state ? state.lastHeartbeatAt || null : null,
        lastHealthCheckAt: state ? state.lastHealthCheckAt || null : null,
        lastFailureType: state ? state.lastFailureType : "none",
        consecutiveFailures: state ? state.consecutiveFailures : 0,
        recoveryStatus: state ? state.recoveryStatus : "idle",
        lastError: state ? state.lastError || null : null,
      },
      metrics: monitoring
        ? {
            health: monitoring.health,
            cpu: monitoring.cpu,
            memory: monitoring.memory,
            uptimeSeconds: monitoring.uptimeSeconds,
            lastHeartbeatAt: monitoring.lastHeartbeatAt,
            traffic: {
              totalRequests,
              successfulRequests: traffic.successfulRequests || 0,
              failedRequests: traffic.failedRequests || 0,
              bytesIn: traffic.bytesIn || 0,
              bytesOut: traffic.bytesOut || 0,
              averageResponseTimeMs: totalRequests > 0
                ? Math.round((traffic.totalResponseTimeMs || 0) / totalRequests)
                : 0,
              minuteBuckets: traffic.minuteBuckets || [],
            },
          }
        : null,
      latestDeployment: latestDeployment ? serializeDeployment(latestDeployment) : null,
      devices: assignments
        .filter((item) => item.deviceId)
        .map((item) => ({
          ...serializeDevice(item.deviceId),
          role: item.role,
          priority: item.priority,
          assignmentStatus: item.status,
          isActiveDevice: String(server.activeDeviceId) === String(item.deviceId._id),
        })),
      lastBackup: lastBackup || null,
    },
  });
};

// ============================================================
// DEVICE ASSIGNMENT (MULTI-DEVICE HOSTING)
// ============================================================

const listServerDevices = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);

  const assignments = await DeviceServer.find({ serverId: server._id, status: { $ne: "removed" } })
    .sort({ priority: 1 })
    .populate("deviceId")
    .lean();

  return res.status(200).json({
    success: true,
    data: {
      activeDeviceId: server.activeDeviceId,
      devices: assignments
        .filter((item) => item.deviceId)
        .map((item) => ({
          ...serializeDevice(item.deviceId),
          role: item.role,
          priority: item.priority,
          assignmentStatus: item.status,
          isActiveDevice: String(server.activeDeviceId) === String(item.deviceId._id),
        })),
    },
  });
};

const assignDevice = async (req, res) => {
  const userId = req.user.userId;
  const server = await getOwnedServer(userId, req.params.serverId);
  const body = req.body || {};
  const device = await findUserDevice(userId, body.deviceId);

  const existing = await DeviceServer.find({ serverId: server._id, status: { $ne: "removed" } });
  const already = existing.find((item) => String(item.deviceId) === String(device._id));

  if (!already && existing.length >= MAX_DEVICES_PER_SERVER) {
    throw createError(
      `A server can be assigned to at most ${MAX_DEVICES_PER_SERVER} devices.`,
      409,
      "DEVICE_LIMIT_REACHED"
    );
  }

  // The first device is the primary. Later devices default to standby.
  const hasPrimary = existing.some(
    (item) => item.role === "primary" && String(item.deviceId) !== String(device._id)
  );

  const role = readEnum(body.role, "role", ["primary", "standby"], { required: false })
    || (hasPrimary ? "standby" : "primary");

  if (role === "primary" && hasPrimary) {
    throw createError(
      "This server already has a primary device. Use failover to change it.",
      409,
      "PRIMARY_ALREADY_ASSIGNED"
    );
  }

  const defaultPriority = role === "primary"
    ? 1
    : Math.max(1, ...existing.map((item) => item.priority || 1)) + 1;

  const priority = readInt(body.priority, "priority", { required: false, min: 1, max: 100 }) || defaultPriority;

  // Upsert makes a repeated request a no-op instead of a duplicate-key error.
  const assignment = await DeviceServer.findOneAndUpdate(
    { serverId: server._id, deviceId: device._id },
    {
      $set: { role, priority, status: already ? already.status : "assigned" },
      $setOnInsert: { assignedAt: new Date() },
    },
    { upsert: true, new: true, runValidators: true }
  );

  if (assignment.status === "removed") {
    assignment.status = "assigned";
    await assignment.save();
  }

  if (role === "primary") {
    await Server.updateOne(
      { _id: server._id, activeDeviceId: null },
      { $set: { activeDeviceId: device._id } }
    );
  }

  await ensureServerEndpoint(server);

  return res.status(already ? 200 : 201).json({
    success: true,
    message: `${device.name} assigned as ${role}.`,
    data: {
      serverId: server._id,
      device: serializeDevice(device),
      role: assignment.role,
      priority: assignment.priority,
      assignmentStatus: assignment.status,
    },
  });
};

const unassignDevice = async (req, res) => {
  const userId = req.user.userId;
  const server = await getOwnedServer(userId, req.params.serverId);
  const device = await findUserDevice(userId, req.params.deviceId);

  const assignment = await DeviceServer.findOne({
    serverId: server._id,
    deviceId: device._id,
    status: { $ne: "removed" },
  });

  if (!assignment) {
    throw createError("That device is not assigned to this server.", 404, "DEVICE_SERVER_ASSIGNMENT_NOT_FOUND");
  }

  const isActiveDevice = String(server.activeDeviceId) === String(device._id);

  if (isActiveDevice && server.desiredState === "running") {
    throw createError(
      "This device is serving the server. Stop the server or fail it over first.",
      409,
      "DEVICE_IN_USE"
    );
  }

  // Queued before the assignment is removed so the agent still accepts it.
  await queueCommand({
    serverId: server._id,
    deviceId: device._id,
    action: "REMOVE_APPLICATION",
    payload: { reason: "unassigned" },
    ttlMs: 24 * 60 * 60 * 1000,
  });

  assignment.status = "removed";
  await assignment.save();

  if (isActiveDevice) {
    await Server.updateOne({ _id: server._id }, { $set: { activeDeviceId: null } });
  }

  await ServerEndpoint.updateOne(
    { serverId: server._id },
    { $pull: { redirectionLinks: { deviceId: device._id } }, $inc: { configVersion: 1 } }
  );

  return res.status(200).json({
    success: true,
    message: `${device.name} removed from this server.`,
    data: { serverId: server._id, deviceId: device._id },
  });
};

// ============================================================
// START / STOP / RESTART
// ============================================================

const ACTIONS = {
  start: { command: "START_APPLICATION", desiredState: "running" },
  stop: { command: "STOP_APPLICATION", desiredState: "stopped" },
  restart: { command: "RESTART_APPLICATION", desiredState: "running" },
};

const serverAction = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);
  const action = readEnum((req.body || {}).action, "action", Object.keys(ACTIONS));
  const { command, desiredState } = ACTIONS[action];

  if (!server.activeDeviceId) {
    throw createError("This server has not been deployed to a device yet.", 409, "NO_ACTIVE_DEVICE");
  }

  if (action !== "stop" && !server.currentDeploymentId) {
    throw createError("Deploy the server before starting it.", 409, "NOT_DEPLOYED");
  }

  const device = await Device.findOne({ _id: server.activeDeviceId, isActive: true });

  if (!device) {
    throw createError("The hosting device is no longer registered.", 409, "DEVICE_UNAVAILABLE");
  }

  // The desired state is stored first. The agent reconciles toward it even
  // if this command is lost or the device is offline right now.
  const update = { desiredState };
  if (desiredState === "running") update.status = "starting";
  if (action === "stop") update.status = "stopping";

  await Server.updateOne({ _id: server._id }, { $set: update });

  const queued = await queueCommand({
    serverId: server._id,
    deviceId: device._id,
    action: command,
    payload: { source: "owner" },
    dedupe: true,
  });

  return res.status(202).json({
    success: true,
    message: isDeviceOnline(device)
      ? `${action} requested.`
      : `${action} requested. ${device.name} is offline and will apply it when it reconnects.`,
    data: {
      serverId: server._id,
      desiredState,
      commandId: queued.commandId,
      deviceOnline: isDeviceOnline(device),
    },
  });
};

// ============================================================
// LOGS
// ============================================================

const getServerLogs = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);
  const { stream, deploymentId, after, before } = req.query;
  const limit = readInt(req.query.limit, "limit", { required: false, min: 1, max: 1000 }) || 200;

  const result = await listLogs({ serverId: server._id, stream, deploymentId, after, before, limit });

  res.set("Cache-Control", "no-store");
  return res.status(200).json({ success: true, data: result });
};

// ============================================================
// DEPLOYMENTS
// ============================================================

const createDeployment = async (req, res) => {
  const userId = req.user.userId;
  const server = await getOwnedServer(userId, req.params.serverId);
  const body = req.body || {};

  let deviceId;
  if (body.deviceId !== undefined && body.deviceId !== null) {
    deviceId = (await findUserDevice(userId, body.deviceId))._id;
  }

  const { deployment, created } = await deployments.createDeployment({
    server,
    userId,
    deviceId,
    trigger: "manual",
    branch: body.branch,
    commitSha: body.commitSha,
    idempotencyKey: req.get("Idempotency-Key") || body.idempotencyKey,
  });

  return res.status(created ? 202 : 200).json({
    success: true,
    message: created ? "Deployment queued." : "Deployment already requested.",
    data: { deployment: serializeDeployment(deployment) },
  });
};

const listDeployments = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);
  const limit = readInt(req.query.limit, "limit", { required: false, min: 1, max: 100 }) || 20;

  let before;
  if (req.query.before !== undefined) {
    const parsed = Date.parse(req.query.before);
    if (!Number.isFinite(parsed)) {
      throw createError("before must be an ISO date.", 400, "VALIDATION_ERROR");
    }
    before = new Date(parsed);
  }

  const items = await deployments.listDeployments({ serverId: server._id, limit, before });

  return res.status(200).json({
    success: true,
    data: { deployments: items.map(serializeDeployment) },
  });
};

const getDeployment = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);

  const deployment = await deployments.getDeployment({
    serverId: server._id,
    deploymentId: String(req.params.deploymentId),
  });

  return res.status(200).json({ success: true, data: { deployment: serializeDeployment(deployment) } });
};

const cancelDeployment = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);

  const deployment = await deployments.cancelDeployment({
    server,
    deploymentId: String(req.params.deploymentId),
  });

  return res.status(200).json({
    success: true,
    message: "Deployment cancelled.",
    data: { deployment: serializeDeployment(deployment) },
  });
};

// Redeploy the exact commit of an earlier successful deployment.
const rollbackDeployment = async (req, res) => {
  const userId = req.user.userId;
  const server = await getOwnedServer(userId, req.params.serverId);

  const target = await Deployment.findOne({
    serverId: server._id,
    deploymentId: String(req.params.deploymentId),
    status: { $in: ["running", "superseded"] },
    "source.type": "git",
  });

  if (!target || !target.source.commitSha) {
    throw createError(
      "Only an earlier successful Git deployment can be rolled back to.",
      409,
      "DEPLOYMENT_NOT_ROLLBACK_TARGET"
    );
  }

  const { deployment } = await deployments.createDeployment({
    server,
    userId,
    trigger: "rollback",
    branch: target.source.branch,
    commitSha: target.source.commitSha,
  });

  return res.status(202).json({
    success: true,
    message: `Rolling back to ${target.source.commitSha.slice(0, 7)}.`,
    data: { deployment: serializeDeployment(deployment) },
  });
};

// ============================================================
// BACKUP AND RESTORE
// ============================================================

const serializeBackup = (backup) => ({
  backupId: backup.backupId,
  status: backup.status,
  trigger: backup.trigger,
  sizeBytes: backup.sizeBytes,
  sha256: backup.sha256 || null,
  commitSha: backup.commitSha || null,
  envRevision: backup.envRevision,
  error: backup.error || null,
  device: backup.deviceId && backup.deviceId.name
    ? { id: backup.deviceId._id, name: backup.deviceId.name }
    : { id: backup.deviceId },
  createdAt: backup.createdAt,
  completedAt: backup.completedAt || null,
});

const createBackup = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);
  const backup = await backups.requestBackup({ server, userId: req.user.userId, trigger: "manual" });

  return res.status(202).json({
    success: true,
    message: "Backup requested.",
    data: { backup: serializeBackup(backup) },
  });
};

const listBackups = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);
  const items = await backups.listBackups({ serverId: server._id });

  return res.status(200).json({
    success: true,
    data: {
      settings: {
        enabled: Boolean(server.backup && server.backup.enabled),
        intervalHours: (server.backup && server.backup.intervalHours) || 24,
        retentionCount: (server.backup && server.backup.retentionCount) || 5,
        lastBackupAt: (server.backup && server.backup.lastBackupAt) || null,
      },
      backups: items.map(serializeBackup),
    },
  });
};

const updateBackupSettings = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);
  const body = req.body || {};
  const update = {};

  const enabled = readBoolean(body.enabled, "enabled", { required: false });
  const intervalHours = readInt(body.intervalHours, "intervalHours", { required: false, min: 1, max: 720 });
  const retentionCount = readInt(body.retentionCount, "retentionCount", { required: false, min: 1, max: 50 });

  if (enabled !== undefined) update["backup.enabled"] = enabled;
  if (intervalHours !== undefined) update["backup.intervalHours"] = intervalHours;
  if (retentionCount !== undefined) update["backup.retentionCount"] = retentionCount;

  if (Object.keys(update).length === 0) {
    throw createError("Provide enabled, intervalHours or retentionCount.", 400, "VALIDATION_ERROR");
  }

  const updated = await Server.findByIdAndUpdate(server._id, { $set: update }, { new: true, runValidators: true });

  return res.status(200).json({ success: true, data: { settings: updated.backup } });
};

const deleteBackup = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);
  await backups.deleteBackup({ server, backupId: String(req.params.backupId) });
  return res.status(200).json({ success: true, message: "Backup deleted." });
};

const restoreBackup = async (req, res) => {
  const userId = req.user.userId;
  const server = await getOwnedServer(userId, req.params.serverId);
  const body = req.body || {};

  let deviceId;
  if (body.deviceId !== undefined && body.deviceId !== null) {
    deviceId = (await findUserDevice(userId, body.deviceId))._id;
  }

  const { deployment } = await backups.requestRestore({
    server,
    userId,
    backupId: String(req.params.backupId),
    deviceId,
  });

  return res.status(202).json({
    success: true,
    message: "Restore queued.",
    data: { deployment: serializeDeployment(deployment) },
  });
};

// ============================================================
// FAILOVER
// ============================================================

const triggerFailover = async (req, res) => {
  const userId = req.user.userId;
  const server = await getOwnedServer(userId, req.params.serverId);
  const target = await findUserDevice(userId, (req.body || {}).targetDeviceId);

  const event = await failover.manualFailover({
    server,
    userId,
    targetDeviceId: String(target._id),
  });

  return res.status(202).json({
    success: true,
    message: `Failover to ${target.name} started.`,
    data: { failoverEventId: event._id, status: event.status, strategy: event.strategy, deploymentId: event.deploymentId },
  });
};

const listFailoverEvents = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);
  const events = await failover.listFailoverEvents({ serverId: server._id });
  const candidates = await failover.findCandidates({ server });

  return res.status(200).json({
    success: true,
    data: {
      enabled: !(server.failover && server.failover.enabled === false),
      lastFailoverAt: (server.failover && server.failover.lastFailoverAt) || null,
      standbyReady: candidates.map((device) => ({ id: device._id, name: device.name })),
      events,
    },
  });
};

const updateFailoverSettings = async (req, res) => {
  const server = await getOwnedServer(req.user.userId, req.params.serverId);
  const enabled = readBoolean((req.body || {}).enabled, "enabled");

  await Server.updateOne({ _id: server._id }, { $set: { "failover.enabled": enabled } });

  return res.status(200).json({ success: true, data: { enabled } });
};

// ============================================================
// DASHBOARD
// ============================================================

// Every figure is computed from stored records at request time.
const getDashboardSummary = async (req, res) => {
  const userId = req.user.userId;

  const servers = await Server.find({ owner: userId, isActive: true, status: { $ne: "deleted" } })
    .select("name slug status desiredState port runtime activeDeviceId currentDeploymentId createdAt")
    .sort({ createdAt: -1 })
    .lean();

  const serverIds = servers.map((server) => server._id);

  const [devices, deploymentCount, unreadNotifications, states, monitoring] = await Promise.all([
    Device.find({ userId, isActive: true }).select("name deviceId lastSeenAt isActive status metrics").lean(),
    Deployment.countDocuments({ serverId: { $in: serverIds } }),
    Notification.countDocuments({ userId, readAt: null }),
    ServerMonitoringState.find({ serverId: { $in: serverIds } }).select("serverId tunnelStatus").lean(),
    MonitoringData.find({ serverId: { $in: serverIds } }).select("serverId health traffic.totalRequests").lean(),
  ]);

  const tunnelByServer = new Map(states.map((state) => [String(state.serverId), state.tunnelStatus]));
  const healthByServer = new Map(monitoring.map((item) => [String(item.serverId), item]));
  const countBy = (status) => servers.filter((server) => server.status === status).length;
  const onlineDevices = devices.filter((device) => isDeviceOnline(device));

  return res.status(200).json({
    success: true,
    data: {
      servers: {
        total: servers.length,
        running: countBy("running"),
        stopped: countBy("stopped"),
        failed: countBy("failed"),
        items: servers.map((server) => {
          const health = healthByServer.get(String(server._id));
          return {
            id: server._id,
            name: server.name,
            slug: server.slug,
            status: server.status,
            desiredState: server.desiredState,
            port: server.port || (server.runtime && server.runtime.port) || null,
            runtime: (server.runtime && (server.runtime.framework || server.runtime.language)) || null,
            tunnelStatus: tunnelByServer.get(String(server._id)) || "unknown",
            health: health ? health.health : "unknown",
            totalRequests: health && health.traffic ? health.traffic.totalRequests || 0 : 0,
          };
        }),
      },
      devices: {
        total: devices.length,
        online: onlineDevices.length,
        offline: devices.length - onlineDevices.length,
      },
      deployments: { total: deploymentCount },
      tunnels: {
        connected: states.filter((state) => state.tunnelStatus === "connected").length,
      },
      notifications: { unread: unreadNotifications },
    },
  });
};

module.exports = {
  serializeDeployment,
  getServerOverview,
  listServerDevices,
  assignDevice,
  unassignDevice,
  serverAction,
  getServerLogs,
  createDeployment,
  listDeployments,
  getDeployment,
  cancelDeployment,
  rollbackDeployment,
  createBackup,
  listBackups,
  updateBackupSettings,
  deleteBackup,
  restoreBackup,
  triggerFailover,
  listFailoverEvents,
  updateFailoverSettings,
  getDashboardSummary,
};
