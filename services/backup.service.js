const crypto = require("crypto");

const Server = require("../models/server.model");
const Device = require("../models/device.model");
const DeviceServer = require("../models/deviceServer.model");
const Backup = require("../models/backup.model");
const Deployment = require("../models/deployment.model");

const { createError } = require("../utils/errors");
const { queueCommand, isDeviceOnline } = require("./hosting.service");
const { notify } = require("./notification.service");
const storage = require("./storage.service");

const MINUTE = 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const storageDriver = () => (process.env.BACKUP_STORAGE_DRIVER || "local").toLowerCase();
const maxBackupBytes = () => Number(process.env.BACKUP_MAX_BYTES) || 2 * 1024 * 1024 * 1024;
const backupStaleMs = () => Number(process.env.BACKUP_STALE_MS) || 45 * MINUTE;

const requestBackup = async ({ server, userId = null, trigger = "manual" }) => {
  if (!server.activeDeviceId) {
    throw createError("This server is not running on any device yet.", 409, "NO_ACTIVE_DEVICE");
  }

  const device = await Device.findOne({ _id: server.activeDeviceId, isActive: true });

  if (!device || !isDeviceOnline(device)) {
    throw createError(
      "The hosting device is offline, so a backup cannot be taken right now.",
      409,
      "DEVICE_OFFLINE"
    );
  }

  const deployment = await Deployment.findOne({
    serverId: server._id,
    deviceId: device._id,
    status: "running",
  }).sort({ finishedAt: -1 });

  if (!deployment) {
    throw createError("Deploy the server before taking a backup.", 409, "NOTHING_TO_BACK_UP");
  }

  const inFlight = await Backup.findOne({
    serverId: server._id,
    status: { $in: ["pending", "uploading"] },
    createdAt: { $gt: new Date(Date.now() - backupStaleMs()) },
  });

  if (inFlight) {
    throw createError("A backup is already in progress.", 409, "BACKUP_IN_PROGRESS");
  }

  const backupId = crypto.randomUUID();
  const driver = storageDriver();

  if (driver === "s3" && !storage.isS3Configured()) {
    throw createError("Backup storage is not configured.", 503, "STORAGE_NOT_CONFIGURED");
  }

  const backup = await Backup.create({
    backupId,
    serverId: server._id,
    deviceId: device._id,
    createdBy: userId,
    deploymentId: deployment.deploymentId,
    commitSha: deployment.source && deployment.source.commitSha,
    trigger,
    status: "pending",
    storage: { driver, key: `backups/${server._id}/${backupId}.tar.gz` },
  });

  const command = await queueCommand({
    serverId: server._id,
    deviceId: device._id,
    action: "CREATE_BACKUP",
    payload: { backupId },
  });

  backup.commandId = command.commandId;
  await backup.save();

  return backup;
};

const findAgentBackup = async ({ device, backupId }) => {
  const backup = await Backup.findOne({ backupId, deviceId: device._id });
  if (!backup) {
    throw createError("Backup not found for this device.", 404, "BACKUP_NOT_FOUND");
  }
  return backup;
};

// Where the agent should send the archive.
const getUploadTarget = async ({ device, backupId }) => {
  const backup = await findAgentBackup({ device, backupId });

  if (!["pending", "uploading"].includes(backup.status)) {
    throw createError("This backup is no longer accepting an upload.", 409, "BACKUP_NOT_UPLOADABLE");
  }

  if (backup.status === "pending") {
    backup.status = "uploading";
    await backup.save();
  }

  if (backup.storage.driver === "s3") {
    return {
      mode: "url",
      method: "PUT",
      url: await storage.generateUploadUrl({
        objectKey: backup.storage.key,
        bucket: storage.backupBucket(),
      }),
      headers: { "Content-Type": "application/gzip" },
      maxBytes: maxBackupBytes(),
    };
  }

  return {
    mode: "api",
    method: "PUT",
    path: `/device-agent/backups/${backup.backupId}/content`,
    headers: { "Content-Type": "application/gzip" },
    maxBytes: maxBackupBytes(),
  };
};

const receiveLocalUpload = async ({ device, backupId, stream }) => {
  const backup = await findAgentBackup({ device, backupId });

  if (backup.storage.driver !== "local" || !["pending", "uploading"].includes(backup.status)) {
    throw createError("This backup is not accepting a direct upload.", 409, "BACKUP_NOT_UPLOADABLE");
  }

  const { sizeBytes, sha256 } = await storage.writeLocalObject({
    key: backup.storage.key,
    stream,
    maxBytes: maxBackupBytes(),
  });

  backup.status = "uploading";
  backup.sizeBytes = sizeBytes;
  backup.sha256 = sha256;
  await backup.save();

  return { sizeBytes, sha256 };
};

const removeStoredObject = async (backup) => {
  try {
    if (backup.storage.driver === "s3") {
      await storage.deleteObject({ objectKey: backup.storage.key, bucket: storage.backupBucket() });
    } else {
      await storage.deleteLocalObject(backup.storage.key);
    }
  } catch (error) {
    console.error(`[SpareShare Backup] Could not delete ${backup.storage.key}:`, error.message);
  }
};

const pruneBackups = async (server) => {
  const keep = (server.backup && server.backup.retentionCount) || 5;

  const expired = await Backup.find({ serverId: server._id, status: "completed" })
    .sort({ completedAt: -1 })
    .skip(keep);

  for (const backup of expired) {
    await removeStoredObject(backup);
    backup.status = "deleted";
    await backup.save();
  }

  return expired.length;
};

const completeBackup = async ({ device, backupId, sizeBytes, sha256, envRevision }) => {
  const backup = await findAgentBackup({ device, backupId });

  if (backup.status === "completed") return backup;

  if (backup.status !== "uploading") {
    throw createError("This backup cannot be completed.", 409, "BACKUP_NOT_COMPLETABLE");
  }

  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || !SHA256_PATTERN.test(String(sha256))) {
    throw createError("Backup size and SHA-256 checksum are required.", 400, "INVALID_BACKUP_METADATA");
  }

  // Verify what actually landed in storage against what the device claims.
  if (backup.storage.driver === "local") {
    if (backup.sizeBytes !== sizeBytes || backup.sha256 !== sha256) {
      throw createError(
        "Uploaded backup does not match the reported checksum.",
        409,
        "BACKUP_INTEGRITY_MISMATCH"
      );
    }
  } else {
    const storedSize = await storage.getObjectSize({
      objectKey: backup.storage.key,
      bucket: storage.backupBucket(),
    });
    if (storedSize !== sizeBytes) {
      throw createError(
        "Uploaded backup size does not match the reported size.",
        409,
        "BACKUP_INTEGRITY_MISMATCH"
      );
    }
    backup.sizeBytes = sizeBytes;
    backup.sha256 = sha256;
  }

  backup.status = "completed";
  backup.completedAt = new Date();
  backup.envRevision = Number.isInteger(envRevision) ? envRevision : 0;
  backup.error = undefined;
  await backup.save();

  const server = await Server.findById(backup.serverId);

  if (server) {
    await Server.updateOne(
      { _id: server._id },
      { $set: { "backup.lastBackupAt": backup.completedAt } }
    );
    await pruneBackups(server);
    await notify({
      userId: server.owner,
      type: "backup.completed",
      severity: "info",
      title: "Backup completed",
      message: `A backup of ${server.name} was saved (${Math.max(1, Math.round(sizeBytes / 1024))} KB).`,
      serverId: server._id,
      deviceId: device._id,
      data: { backupId: backup.backupId },
    });
  }

  return backup;
};

const markBackupFailed = async (backup, reason) => {
  backup.status = "failed";
  backup.error = String(reason || "Backup failed.").slice(0, 2000);
  await backup.save();
  await removeStoredObject(backup);

  const server = await Server.findById(backup.serverId);

  if (server) {
    await notify({
      userId: server.owner,
      type: "backup.failed",
      severity: "warning",
      title: "Backup failed",
      message: `The backup of ${server.name} failed: ${backup.error}`.slice(0, 1000),
      serverId: server._id,
      deviceId: backup.deviceId,
      data: { backupId: backup.backupId },
    });
  }
};

const failBackup = async ({ device, backupId, error }) => {
  const backup = await findAgentBackup({ device, backupId });
  if (!["pending", "uploading"].includes(backup.status)) return backup;
  await markBackupFailed(backup, error);
  return backup;
};

// A device may download a backup only for a server it is assigned to.
const findRestorableBackup = async ({ device, backupId }) => {
  const backup = await Backup.findOne({ backupId, status: "completed" });

  if (!backup) {
    throw createError("Backup not found.", 404, "BACKUP_NOT_FOUND");
  }

  const assignment = await DeviceServer.exists({
    deviceId: device._id,
    serverId: backup.serverId,
    status: { $ne: "removed" },
  });

  if (!assignment) {
    throw createError("This device is not assigned to that server.", 403, "BACKUP_ACCESS_DENIED");
  }

  return backup;
};

const getDownloadSource = async ({ device, backupId }) => {
  const backup = await findRestorableBackup({ device, backupId });
  const base = { sha256: backup.sha256, sizeBytes: backup.sizeBytes, envRevision: backup.envRevision };

  if (backup.storage.driver === "s3") {
    return {
      ...base,
      mode: "url",
      url: await storage.generateDownloadUrl({
        objectKey: backup.storage.key,
        bucket: storage.backupBucket(),
        expiresIn: 3600,
      }),
    };
  }

  return { ...base, mode: "api", path: `/device-agent/backups/${backup.backupId}/content` };
};

const openLocalDownload = async ({ device, backupId }) => {
  const backup = await findRestorableBackup({ device, backupId });

  if (backup.storage.driver !== "local") {
    throw createError("This backup is not stored on the API server.", 409, "BACKUP_NOT_LOCAL");
  }

  return storage.openLocalObject(backup.storage.key);
};

const listBackups = async ({ serverId, limit = 30 }) =>
  Backup.find({ serverId, status: { $ne: "deleted" } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("-storage -commandId")
    .populate("deviceId", "name deviceId")
    .lean();

const deleteBackup = async ({ server, backupId }) => {
  const backup = await Backup.findOne({
    backupId,
    serverId: server._id,
    status: { $in: ["completed", "failed"] },
  });

  if (!backup) {
    throw createError("Backup not found.", 404, "BACKUP_NOT_FOUND");
  }

  await removeStoredObject(backup);
  backup.status = "deleted";
  await backup.save();
  return backup;
};

// Restore runs through the deployment pipeline so progress, logs and
// failure handling are identical to a normal deploy.
const requestRestore = async ({ server, userId = null, backupId, deviceId, trigger = "restore" }) => {
  const backup = await Backup.findOne({ backupId, serverId: server._id, status: "completed" });

  if (!backup) {
    throw createError("Backup not found or not completed.", 404, "BACKUP_NOT_FOUND");
  }

  const { createDeployment } = require("./deployment.service");

  return createDeployment({
    server,
    userId,
    deviceId,
    trigger,
    source: { type: "backup", backupId: backup.backupId, commitSha: backup.commitSha },
  });
};

// ------------------------------------------------------------
// Scheduler hooks
// ------------------------------------------------------------

const scheduleDueBackups = async () => {
  const now = new Date();

  const candidates = await Server.find({
    isActive: true,
    status: "running",
    desiredState: "running",
    activeDeviceId: { $ne: null },
    "backup.enabled": true,
  })
    .limit(100)
    .lean();

  let queued = 0;

  for (const candidate of candidates) {
    const intervalMs = ((candidate.backup && candidate.backup.intervalHours) || 24) * 60 * MINUTE;
    const dueBefore = new Date(now.getTime() - intervalMs);
    const last = candidate.backup && candidate.backup.lastScheduledAt;

    if (last && new Date(last) > dueBefore) continue;

    // Atomic claim so two API instances do not both schedule the backup.
    const server = await Server.findOneAndUpdate(
      {
        _id: candidate._id,
        $or: [
          { "backup.lastScheduledAt": { $exists: false } },
          { "backup.lastScheduledAt": null },
          { "backup.lastScheduledAt": { $lte: dueBefore } },
        ],
      },
      { $set: { "backup.lastScheduledAt": now } },
      { new: true }
    );

    if (!server) continue;

    try {
      await requestBackup({ server, trigger: "scheduled" });
      queued += 1;
    } catch (error) {
      console.error(`[SpareShare Backup] Scheduled backup skipped for ${server._id}: ${error.message}`);
    }
  }

  return queued;
};

const failStaleBackups = async () => {
  const stale = await Backup.find({
    status: { $in: ["pending", "uploading"] },
    updatedAt: { $lt: new Date(Date.now() - backupStaleMs()) },
  }).limit(50);

  for (const backup of stale) {
    await markBackupFailed(backup, "The device did not finish the backup in time.");
  }

  return stale.length;
};

module.exports = {
  requestBackup,
  getUploadTarget,
  receiveLocalUpload,
  completeBackup,
  failBackup,
  getDownloadSource,
  openLocalDownload,
  listBackups,
  deleteBackup,
  requestRestore,
  scheduleDueBackups,
  failStaleBackups,
};
