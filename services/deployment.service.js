const crypto = require("crypto");

const Server = require("../models/server.model");
const Device = require("../models/device.model");
const DeviceServer = require("../models/deviceServer.model");
const Deployment = require("../models/deployment.model");
const Backup = require("../models/backup.model");
const ServerEnvironment = require("../models/serverEnvironment.model");
const MonitoringData = require("../models/monitoringData.model");

const { DEPLOYMENT_STATUSES, IN_PROGRESS_STATUSES, FINAL_STATUSES } = Deployment;

const { createError } = require("../utils/errors");
const { isObjectId } = require("../utils/validate");
const { queueCommand, isDeviceOnline } = require("./hosting.service");
const { ensureServerEndpoint } = require("./endpoint.service");
const { notify } = require("./notification.service");
const { createRepositoryCloneToken } = require("./github.service");

const AGENT_REPORTABLE = [...IN_PROGRESS_STATUSES.filter((s) => s !== "queued"), "running", "failed"];

const deploymentStaleMs = () => Number(process.env.DEPLOYMENT_STALE_MS) || 20 * 60 * 1000;

const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._\/-]{1,200}$/;
const COMMIT_PATTERN = /^[a-f0-9]{7,40}$/i;

// Pick the device a deployment should run on.
const resolveTargetDevice = async ({ server, deviceId }) => {
  let targetId = deviceId || server.activeDeviceId;

  if (!targetId) {
    const preferred = await DeviceServer.findOne({
      serverId: server._id,
      status: { $ne: "removed" },
    }).sort({ priority: 1, assignedAt: 1 });

    if (!preferred) {
      throw createError(
        "Assign a hosting device to this server before deploying.",
        409,
        "NO_ASSIGNED_DEVICE"
      );
    }
    targetId = preferred.deviceId;
  }

  if (!isObjectId(targetId)) {
    throw createError("Invalid device identifier.", 400, "INVALID_DEVICE_ID");
  }

  const assignment = await DeviceServer.findOne({
    serverId: server._id,
    deviceId: targetId,
    status: { $ne: "removed" },
  });

  if (!assignment) {
    throw createError(
      "That device is not assigned to this server.",
      409,
      "DEVICE_SERVER_ASSIGNMENT_NOT_FOUND"
    );
  }

  const device = await Device.findOne({ _id: targetId, userId: server.owner, isActive: true });

  if (!device) {
    throw createError("Device not found for this account.", 404, "DEVICE_NOT_FOUND");
  }

  return device;
};

const buildGitSource = ({ server, branch, commitSha }) => {
  const repository = server.repository || {};

  if (!repository.repositoryUrl) {
    throw createError(
      "This server has no repository configured.",
      409,
      "REPOSITORY_NOT_CONFIGURED"
    );
  }

  const resolvedBranch = branch || repository.branch || "main";

  if (!BRANCH_PATTERN.test(resolvedBranch)) {
    throw createError("Branch name is invalid.", 400, "INVALID_BRANCH");
  }

  if (commitSha !== undefined && commitSha !== null && !COMMIT_PATTERN.test(commitSha)) {
    throw createError("Commit SHA is invalid.", 400, "INVALID_COMMIT_SHA");
  }

  return {
    type: "git",
    repositoryUrl: repository.repositoryUrl,
    fullName: repository.fullName,
    repositoryId: repository.repositoryId,
    installationId: repository.installationId,
    isPrivate: Boolean(repository.isPrivate),
    branch: resolvedBranch,
    commitSha: commitSha || undefined,
  };
};

const createDeployment = async ({
  server,
  userId = null,
  deviceId,
  trigger = "manual",
  source,
  branch,
  commitSha,
  idempotencyKey,
  requireOnline = true,
}) => {
  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,100}$/.test(idempotencyKey)) {
      throw createError("Idempotency key is invalid.", 400, "INVALID_IDEMPOTENCY_KEY");
    }
    const previous = await Deployment.findOne({ serverId: server._id, idempotencyKey });
    if (previous) return { deployment: previous, created: false };
  }

  const device = await resolveTargetDevice({ server, deviceId });

  if (requireOnline && !isDeviceOnline(device)) {
    throw createError(
      `${device.name} is offline. Start the SpareShare agent on the device and try again.`,
      409,
      "DEVICE_OFFLINE"
    );
  }

  const resolvedSource = source || buildGitSource({ server, branch, commitSha });

  const environment = await ServerEnvironment.findOne({ serverId: server._id })
    .select("revision")
    .lean();

  let deployment;

  try {
    deployment = await Deployment.create({
      deploymentId: crypto.randomUUID(),
      serverId: server._id,
      deviceId: device._id,
      triggeredBy: userId,
      trigger,
      source: resolvedSource,
      status: "queued",
      isActive: true,
      idempotencyKey,
      envRevision: environment ? environment.revision : 0,
      steps: [{ name: "queued", status: "running", startedAt: new Date() }],
    });
  } catch (error) {
    if (error.code === 11000) {
      if (idempotencyKey) {
        const raced = await Deployment.findOne({ serverId: server._id, idempotencyKey });
        if (raced) return { deployment: raced, created: false };
      }
      throw createError(
        "A deployment is already in progress for this server on that device.",
        409,
        "DEPLOYMENT_IN_PROGRESS"
      );
    }
    throw error;
  }

  const command = await queueCommand({
    serverId: server._id,
    deviceId: device._id,
    action: "DEPLOY",
    payload: { deploymentId: deployment.deploymentId },
  });

  deployment.commandId = command.commandId;
  await deployment.save();

  await ensureServerEndpoint(server);

  // Deploying implies the owner wants the server up. The first device to
  // receive a deployment becomes the active device.
  await Server.updateOne({ _id: server._id }, { $set: { desiredState: "running" } });
  await Server.updateOne(
    { _id: server._id, activeDeviceId: null },
    { $set: { activeDeviceId: device._id } }
  );

  return { deployment, created: true };
};

// Everything the agent needs to carry out one deployment. Clone
// credentials are minted per request and never stored.
const getDeploymentSpecForAgent = async ({ device, deploymentId }) => {
  const deployment = await Deployment.findOne({ deploymentId, deviceId: device._id });

  if (!deployment) {
    throw createError("Deployment not found for this device.", 404, "DEPLOYMENT_NOT_FOUND");
  }

  if (!deployment.isActive) {
    throw createError("This deployment is no longer active.", 409, "DEPLOYMENT_FINISHED");
  }

  const server = await Server.findOne({ _id: deployment.serverId, isActive: true });

  if (!server) {
    throw createError("Server not found or inactive.", 404, "SERVER_NOT_FOUND");
  }

  const source = { type: deployment.source.type };

  if (deployment.source.type === "git") {
    source.cloneUrl = deployment.source.repositoryUrl;
    source.branch = deployment.source.branch;
    source.commitSha = deployment.source.commitSha || null;

    if (deployment.source.isPrivate) {
      if (!deployment.source.installationId || !deployment.source.repositoryId) {
        throw createError(
          "This private repository is not linked to a GitHub App installation.",
          409,
          "REPOSITORY_ACCESS_NOT_CONFIGURED"
        );
      }
      const { token, expiresAt } = await createRepositoryCloneToken(
        deployment.source.installationId,
        deployment.source.repositoryId
      );
      source.auth = { username: "x-access-token", token, expiresAt };
    }
  } else {
    const backup = await Backup.findOne({
      backupId: deployment.source.backupId,
      serverId: server._id,
      status: "completed",
    });
    if (!backup) {
      throw createError("The backup for this restore is unavailable.", 409, "BACKUP_UNAVAILABLE");
    }
    source.backupId = backup.backupId;
    source.sha256 = backup.sha256;
    source.sizeBytes = backup.sizeBytes;
  }

  const environment = await ServerEnvironment.findOne({ serverId: server._id })
    .select("revision")
    .lean();

  const build = server.build || {};

  return {
    deploymentId: deployment.deploymentId,
    serverId: server._id,
    name: server.name,
    slug: server.slug,
    port: server.port || null,
    trigger: deployment.trigger,
    source,
    build: {
      rootDirectory: build.rootDirectory || "",
      installCommand: build.installCommand || null,
      buildCommand: build.buildCommand || null,
      startCommand: build.startCommand || null,
      healthCheckPath: build.healthCheckPath || "/",
    },
    resources: {
      memoryLimitMb: (server.resources && server.resources.memoryLimitMb) || null,
    },
    environmentRevision: environment ? environment.revision : 0,
  };
};

const sanitizeDetection = (detection) => {
  if (!detection || typeof detection !== "object" || Array.isArray(detection)) return null;
  const pick = (value, max = 200) => (typeof value === "string" ? value.slice(0, max) : undefined);
  return {
    language: pick(detection.language, 40),
    framework: pick(detection.framework, 60),
    packageManager: pick(detection.packageManager, 40),
    runtimeVersion: pick(detection.runtimeVersion, 40),
    rootDirectory: pick(detection.rootDirectory, 300),
    installCommand: pick(detection.installCommand, 500),
    buildCommand: pick(detection.buildCommand, 500),
    startCommand: pick(detection.startCommand, 500),
    port: Number.isInteger(detection.port) ? detection.port : undefined,
    confidence: pick(detection.confidence, 20),
    notes: Array.isArray(detection.notes)
      ? detection.notes.slice(0, 20).map((note) => String(note).slice(0, 300))
      : undefined,
  };
};

const recordDeploymentProgress = async ({
  device,
  deploymentId,
  status,
  message,
  detection,
  error,
  commitSha,
  port,
}) => {
  if (!AGENT_REPORTABLE.includes(status)) {
    throw createError("Invalid deployment status.", 400, "INVALID_DEPLOYMENT_STATUS");
  }

  const deployment = await Deployment.findOne({ deploymentId, deviceId: device._id });

  if (!deployment) {
    throw createError("Deployment not found for this device.", 404, "DEPLOYMENT_NOT_FOUND");
  }

  if (FINAL_STATUSES.includes(deployment.status)) {
    // A retried final report is acknowledged. Anything else tells the
    // agent the deployment ended (cancelled or timed out) so it stops.
    if (deployment.status === status) return deployment;
    throw createError(
      `This deployment already finished with status "${deployment.status}".`,
      409,
      "DEPLOYMENT_FINISHED"
    );
  }

  const now = new Date();
  const currentIndex = DEPLOYMENT_STATUSES.indexOf(deployment.status);
  const nextIndex = DEPLOYMENT_STATUSES.indexOf(status);
  const isFinal = status === "running" || status === "failed";

  if (!isFinal && nextIndex < currentIndex) {
    throw createError("Deployment status cannot move backwards.", 409, "INVALID_STATUS_TRANSITION");
  }

  const text = typeof message === "string" ? message.slice(0, 2000) : undefined;
  const lastStep = deployment.steps[deployment.steps.length - 1];

  if (status === deployment.status) {
    // Keep-alive during a long step.
    if (lastStep && text) lastStep.message = text;
    deployment.markModified("steps");
  } else {
    if (lastStep && lastStep.status === "running") {
      lastStep.status = status === "failed" ? "failed" : "completed";
      lastStep.finishedAt = now;
      if (status === "failed" && text) lastStep.message = text;
    }
    if (!isFinal) {
      deployment.steps.push({ name: status, status: "running", message: text, startedAt: now });
    }
    deployment.status = status;
  }

  if (!deployment.startedAt) deployment.startedAt = now;

  const cleanDetection = sanitizeDetection(detection);
  if (cleanDetection) deployment.detection = cleanDetection;

  if (typeof commitSha === "string" && COMMIT_PATTERN.test(commitSha)) {
    deployment.source.commitSha = commitSha.toLowerCase();
  }

  if (isFinal) {
    deployment.isActive = false;
    deployment.finishedAt = now;
    if (status === "failed") {
      deployment.error = String(error || message || "Deployment failed.").slice(0, 4000);
    }
  }

  // Bumps updatedAt even for a keep-alive so the stale sweeper sees progress.
  deployment.updatedAt = now;
  await deployment.save();

  if (isFinal) await finalizeDeployment({ deployment, device, port });

  return deployment;
};

const finalizeDeployment = async ({ deployment, device, port }) => {
  const server = await Server.findById(deployment.serverId);
  if (!server) return;

  if (deployment.status === "running") {
    await Deployment.updateMany(
      {
        serverId: deployment.serverId,
        deviceId: deployment.deviceId,
        status: "running",
        _id: { $ne: deployment._id },
      },
      { $set: { status: "superseded" } }
    );

    const update = { currentDeploymentId: deployment.deploymentId };
    const detection = deployment.detection;

    if (detection) {
      update.runtime = {
        language: detection.language,
        framework: detection.framework,
        packageManager: detection.packageManager,
        runtimeVersion: detection.runtimeVersion,
        detectedAt: new Date(),
      };
    }

    // The port the agent bound on this device. Informational only: it is
    // never pinned, because another device may need a different one.
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      if (update.runtime) update.runtime.port = port;
      else update["runtime.port"] = port;
    }

    if (String(server.activeDeviceId) === String(device._id)) {
      update.status = "running";
      update.startedAt = new Date();

      // The agent only reports "running" after a passed health check, so
      // the permanent URL can serve right away.
      await MonitoringData.updateOne(
        { serverId: server._id },
        {
          $set: { health: "healthy", lastHeartbeatAt: new Date() },
          $setOnInsert: { serverId: server._id },
        },
        { upsert: true }
      );
    }

    await Server.updateOne({ _id: server._id }, { $set: update });

    await notify({
      userId: server.owner,
      type: "deployment.succeeded",
      severity: "success",
      title: "Deployment succeeded",
      message: `${server.name} is running on ${device.name}.`,
      serverId: server._id,
      deviceId: device._id,
      data: { deploymentId: deployment.deploymentId },
    });
  } else {
    await notify({
      userId: server.owner,
      type: "deployment.failed",
      severity: "critical",
      title: "Deployment failed",
      message: `${server.name} could not be deployed on ${device.name}: ${deployment.error}`.slice(0, 1000),
      serverId: server._id,
      deviceId: device._id,
      data: { deploymentId: deployment.deploymentId },
    });
  }

  await require("./failover.service").onDeploymentFinished({ deployment, server });
};

const cancelDeployment = async ({ server, deploymentId }) => {
  const deployment = await Deployment.findOneAndUpdate(
    { deploymentId, serverId: server._id, isActive: true },
    {
      $set: {
        status: "cancelled",
        isActive: false,
        finishedAt: new Date(),
        error: "Cancelled by the owner.",
      },
    },
    { new: true }
  );

  if (!deployment) {
    throw createError(
      "Deployment not found or already finished.",
      404,
      "DEPLOYMENT_NOT_CANCELLABLE"
    );
  }

  await require("./failover.service").onDeploymentFinished({ deployment, server });
  return deployment;
};

// Deployments whose agent went silent are failed so the per-server lock is
// released and a new deployment can start.
const failStaleDeployments = async () => {
  const cutoff = new Date(Date.now() - deploymentStaleMs());

  const stale = await Deployment.find({ isActive: true, updatedAt: { $lt: cutoff } }).limit(50);

  for (const item of stale) {
    const deployment = await Deployment.findOneAndUpdate(
      { _id: item._id, isActive: true, updatedAt: { $lt: cutoff } },
      {
        $set: {
          status: "failed",
          isActive: false,
          finishedAt: new Date(),
          error: "The device stopped reporting progress and the deployment timed out.",
        },
      },
      { new: true }
    );

    if (!deployment) continue;

    const [server, device] = await Promise.all([
      Server.findById(deployment.serverId),
      Device.findById(deployment.deviceId),
    ]);

    if (server && device) {
      await notify({
        userId: server.owner,
        type: "deployment.failed",
        severity: "critical",
        title: "Deployment timed out",
        message: `${server.name} on ${device.name} stopped reporting progress.`,
        serverId: server._id,
        deviceId: device._id,
        data: { deploymentId: deployment.deploymentId },
      });
      await require("./failover.service").onDeploymentFinished({ deployment, server });
    }
  }

  return stale.length;
};

const listDeployments = async ({ serverId, limit = 20, before }) => {
  const filter = { serverId };
  if (before) filter.createdAt = { $lt: before };

  return Deployment.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("deviceId", "name deviceId status")
    .lean();
};

const getDeployment = async ({ serverId, deploymentId }) => {
  const deployment = await Deployment.findOne({ serverId, deploymentId })
    .populate("deviceId", "name deviceId status")
    .lean();

  if (!deployment) {
    throw createError("Deployment not found.", 404, "DEPLOYMENT_NOT_FOUND");
  }

  return deployment;
};

module.exports = {
  BRANCH_PATTERN,
  COMMIT_PATTERN,
  resolveTargetDevice,
  createDeployment,
  getDeploymentSpecForAgent,
  recordDeploymentProgress,
  cancelDeployment,
  failStaleDeployments,
  listDeployments,
  getDeployment,
};
