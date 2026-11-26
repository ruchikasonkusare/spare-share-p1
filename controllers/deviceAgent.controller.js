const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { getEnvironmentForAgent } = require("../services/serverEnvironment.service");

const {
  createError,
  provisionAgentCredential,
  processHeartbeat,
  getDeviceConfiguration,
  getPendingCommands,
  updateTunnelDestination,
  createRecoveryCommand,
  reportCommandResult,
  assertDeviceServerAssignment,
} = require("../services/hosting.service");

const { findUserDevice } = require("../services/server.service");
const deployments = require("../services/deployment.service");
const backups = require("../services/backup.service");
const { appendLogs } = require("../services/log.service");
const { generateDownloadUrl } = require("../services/storage.service");

const HEARTBEAT_INTERVAL_SECONDS = Number(process.env.AGENT_HEARTBEAT_INTERVAL_SECONDS) || 30;
const COMMAND_POLL_INTERVAL_SECONDS = Number(process.env.AGENT_COMMAND_POLL_INTERVAL_SECONDS) || 10;

// ============================================================
// USER-AUTHENTICATED
// ============================================================

const provisionDeviceAgent = async (req, res) => {
  const device = await findUserDevice(req.user.userId, req.params.deviceId);

  const credential = await provisionAgentCredential({
    deviceId: String(device._id),
    userId: req.user.userId,
  });

  res.set("Cache-Control", "no-store");

  return res.status(201).json({
    success: true,
    message: "Device agent credential generated. Store it securely; it will not be returned again.",
    data: credential,
  });
};

const queueCommand = async (req, res) => {
  const { serverId, deviceId, action, payload } = req.body || {};

  const command = await createRecoveryCommand({
    userId: req.user.userId,
    serverId,
    deviceId,
    action,
    payload: payload === undefined ? {} : payload,
  });

  return res.status(201).json({
    success: true,
    message: "Command queued.",
    data: {
      commandId: command.commandId,
      serverId: command.serverId,
      deviceId: command.deviceId,
      action: command.action,
      status: command.status,
      expiresAt: command.expiresAt,
    },
  });
};

// ============================================================
// AGENT-AUTHENTICATED
// ============================================================

const heartbeat = async (req, res) => {
  const result = await processHeartbeat({ device: req.agent.device, payload: req.body || {} });
  return res.status(200).json({ success: true, message: "Heartbeat received.", data: result });
};

const getConfiguration = async (req, res) => {
  const servers = await getDeviceConfiguration(req.agent.device);

  return res.status(200).json({
    success: true,
    data: {
      deviceId: req.agent.device._id,
      publicDeviceId: req.agent.device.deviceId,
      heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS,
      commandPollingIntervalSeconds: COMMAND_POLL_INTERVAL_SECONDS,
      servers,
    },
  });
};

const pollCommands = async (req, res) => {
  const commands = await getPendingCommands(req.agent.device);

  return res.status(200).json({
    success: true,
    count: commands.length,
    commands: commands.map((command) => ({
      commandId: command.commandId,
      serverId: command.serverId,
      action: command.action,
      payload: command.payload || {},
      expiresAt: command.expiresAt,
      createdAt: command.createdAt,
    })),
  });
};

const commandResult = async (req, res) => {
  const { status, result, error } = req.body || {};

  const command = await reportCommandResult({
    device: req.agent.device,
    commandId: req.params.commandId,
    status,
    result,
    error,
  });

  return res.status(200).json({
    success: true,
    message: "Command result recorded.",
    data: {
      commandId: command.commandId,
      status: command.status,
      completedAt: command.completedAt || null,
    },
  });
};

const updateTunnel = async (req, res) => {
  const result = await updateTunnelDestination({
    device: req.agent.device,
    serverId: req.params.serverId,
    tunnelUrl: (req.body || {}).tunnelUrl,
  });

  return res.status(200).json({
    success: true,
    message: "Tunnel destination updated successfully.",
    data: result,
  });
};

// Decrypted environment for a server this device is assigned to.
const getServerEnvironment = async (req, res) => {
  const result = await getEnvironmentForAgent({
    device: req.agent.device,
    serverId: req.params.serverId,
  });

  res.set("Cache-Control", "no-store");
  return res.status(200).json({ success: true, data: result });
};

const pushLogs = async (req, res) => {
  const { server } = await assertDeviceServerAssignment(req.agent.device._id, req.params.serverId);

  const stored = await appendLogs({
    device: req.agent.device,
    serverId: server._id,
    entries: (req.body || {}).entries,
  });

  return res.status(200).json({ success: true, data: { stored } });
};

const getDeploymentSpec = async (req, res) => {
  const spec = await deployments.getDeploymentSpecForAgent({
    device: req.agent.device,
    deploymentId: req.params.deploymentId,
  });

  // The response can carry a short-lived clone credential.
  res.set("Cache-Control", "no-store");
  return res.status(200).json({ success: true, data: spec });
};

const deploymentProgress = async (req, res) => {
  const body = req.body || {};

  const deployment = await deployments.recordDeploymentProgress({
    device: req.agent.device,
    deploymentId: req.params.deploymentId,
    status: body.status,
    message: body.message,
    detection: body.detection,
    error: body.error,
    commitSha: body.commitSha,
    port: body.port,
  });

  return res.status(200).json({
    success: true,
    data: { deploymentId: deployment.deploymentId, status: deployment.status },
  });
};

const backupUploadTarget = async (req, res) => {
  const target = await backups.getUploadTarget({
    device: req.agent.device,
    backupId: req.params.backupId,
  });

  res.set("Cache-Control", "no-store");
  return res.status(200).json({ success: true, data: target });
};

const backupUploadContent = async (req, res) => {
  const result = await backups.receiveLocalUpload({
    device: req.agent.device,
    backupId: req.params.backupId,
    stream: req,
  });

  return res.status(200).json({ success: true, data: result });
};

const backupComplete = async (req, res) => {
  const body = req.body || {};

  const backup = await backups.completeBackup({
    device: req.agent.device,
    backupId: req.params.backupId,
    sizeBytes: body.sizeBytes,
    sha256: body.sha256,
    envRevision: body.envRevision,
  });

  return res.status(200).json({
    success: true,
    data: { backupId: backup.backupId, status: backup.status },
  });
};

const backupFail = async (req, res) => {
  const backup = await backups.failBackup({
    device: req.agent.device,
    backupId: req.params.backupId,
    error: (req.body || {}).error,
  });

  return res.status(200).json({
    success: true,
    data: { backupId: backup.backupId, status: backup.status },
  });
};

const backupDownloadSource = async (req, res) => {
  const source = await backups.getDownloadSource({
    device: req.agent.device,
    backupId: req.params.backupId,
  });

  res.set("Cache-Control", "no-store");
  return res.status(200).json({ success: true, data: source });
};

const backupDownloadContent = async (req, res, next) => {
  const { stream, sizeBytes } = await backups.openLocalDownload({
    device: req.agent.device,
    backupId: req.params.backupId,
  });

  res.setHeader("Content-Type", "application/gzip");
  res.setHeader("Content-Length", String(sizeBytes));
  res.setHeader("Cache-Control", "no-store");

  stream.on("error", (error) => {
    if (!res.headersSent) return next(error);
    return res.destroy(error);
  });

  stream.pipe(res);
};

// ------------------------------------------------------------
// Runtime archives (optional mirror in object storage)
// ------------------------------------------------------------

const RUNTIME_OBJECTS = {
  node: "B2_OBJECT_NPM",
  python: "B2_OBJECT_PYTHON",
  jdk: "B2_OBJECT_JDK",
  pip: "B2_OBJECT_PIP",
  cloudflared: "B2_OBJECT_CLOUDFLARED",
};

const getRuntimeArchive = async (req, res) => {
  const envName = RUNTIME_OBJECTS[req.params.name];

  if (!envName) {
    throw createError("Unknown runtime archive.", 404, "RUNTIME_NOT_FOUND");
  }

  const objectKey = process.env[envName];

  if (!objectKey) {
    throw createError(
      `No mirrored archive is configured for ${req.params.name}.`,
      404,
      "RUNTIME_NOT_CONFIGURED"
    );
  }

  const downloadUrl = await generateDownloadUrl({ objectKey, filename: path.basename(objectKey) });

  res.set("Cache-Control", "no-store");
  return res.status(200).json({
    success: true,
    data: { name: req.params.name, filename: path.basename(objectKey), downloadUrl, expiresIn: 900 },
  });
};

// ------------------------------------------------------------
// Agent self-distribution
// ------------------------------------------------------------

const bundlePath = () =>
  path.resolve(
    //process.env.AGENT_BUNDLE_PATH ||
      //path.join(__dirname, "..", "..", "agent", "dist", "spareshare-agent.js")
      path.join(
        __dirname,
        "..",
        "storage",
        "agent",
        "spareshare-agent.js"
      )
  );

let bundleCache = null;

const readBundle = async () => {
  const file = bundlePath();
  const stat = await fs.promises.stat(file).catch(() => null);

  if (!stat || !stat.isFile()) {
    throw createError(
      "The device agent bundle has not been built on this server.",
      503,
      "AGENT_BUNDLE_UNAVAILABLE"
    );
  }

  if (!bundleCache || bundleCache.mtimeMs !== stat.mtimeMs) {
    const content = await fs.promises.readFile(file);
    const version = /AGENT_VERSION\s*=\s*"([^"]+)"/.exec(content.toString("utf8"));
    bundleCache = {
      mtimeMs: stat.mtimeMs,
      content,
      sizeBytes: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      version: version ? version[1] : "unknown",
    };
  }

  return bundleCache;
};

const getBundleMeta = async (req, res) => {
  const bundle = await readBundle();
  return res.status(200).json({
    success: true,
    data: { version: bundle.version, sha256: bundle.sha256, sizeBytes: bundle.sizeBytes },
  });
};

const getBundle = async (req, res) => {
  const bundle = await readBundle();
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Content-Length", String(bundle.sizeBytes));
  res.setHeader("X-Agent-Version", bundle.version);
  res.setHeader("X-Agent-Sha256", bundle.sha256);
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).end(bundle.content);
};

module.exports = {
  provisionDeviceAgent,
  queueCommand,
  heartbeat,
  getConfiguration,
  pollCommands,
  commandResult,
  updateTunnel,
  getServerEnvironment,
  pushLogs,
  getDeploymentSpec,
  deploymentProgress,
  backupUploadTarget,
  backupUploadContent,
  backupComplete,
  backupFail,
  backupDownloadSource,
  backupDownloadContent,
  getRuntimeArchive,
  getBundleMeta,
  getBundle,
};
