const {
  createError,
  getServerEnvironment,
  updateServerEnvironment,
  deleteServerEnvironmentVariable,
  assertServerOwner,
} = require("../services/serverEnvironment.service");

const Device = require("../models/device.model");
const DeviceServer = require("../models/deviceServer.model");
const ServerEnvironment = require("../models/serverEnvironment.model");
const { queueCommand } = require("../services/hosting.service");

// Queue SYNC_ENV for every device that holds a copy of the server. The
// agent rewrites the .env file, updates the process environment and
// restarts the application only when the revision actually changed.
const queueEnvironmentSync = async ({ serverId, userId, revision }) => {
  const assignments = await DeviceServer.find({
    serverId,
    status: { $ne: "removed" },
  }).lean();

  const commands = [];

  for (const assignment of assignments) {
    const device = await Device.findOne({ _id: assignment.deviceId, userId, isActive: true });
    if (!device) continue;

    const command = await queueCommand({
      serverId,
      deviceId: device._id,
      action: "SYNC_ENV",
      payload: { environmentRevision: revision },
      // Several quick edits collapse into one pending sync per device.
      dedupe: true,
    });

    commands.push({ deviceId: device._id, commandId: command.commandId });
  }

  return commands;
};

const getEnvironment = async (req, res) => {
  const result = await getServerEnvironment({
    serverId: req.params.serverId,
    userId: req.user?.userId,
  });

  res.set("Cache-Control", "no-store");
  return res.status(200).json({ success: true, data: result });
};

const saveEnvironment = async (req, res) => {
  const userId = req.user?.userId;
  const { serverId } = req.params;
  const { variables, sync } = req.body || {};

  const result = await updateServerEnvironment({ serverId, userId, variables });

  const commands = sync === false
    ? []
    : await queueEnvironmentSync({ serverId, userId, revision: result.revision });

  return res.status(200).json({
    success: true,
    message: "Environment variables saved successfully.",
    data: { ...result, syncQueuedDevices: commands.length },
  });
};

const deleteEnvironmentVariable = async (req, res) => {
  const userId = req.user?.userId;
  const { serverId, key } = req.params;

  const result = await deleteServerEnvironmentVariable({ serverId, userId, key });
  const commands = await queueEnvironmentSync({ serverId, userId, revision: result.revision });

  return res.status(200).json({
    success: true,
    message: "Environment variable deleted successfully.",
    data: { ...result, syncQueuedDevices: commands.length },
  });
};

const syncEnvironment = async (req, res) => {
  const userId = req.user?.userId;
  const { serverId } = req.params;

  await assertServerOwner({ serverId, userId });

  const environment = await ServerEnvironment.findOne({ serverId });

  if (!environment) {
    throw createError(
      "No environment configuration exists for this server.",
      404,
      "ENVIRONMENT_NOT_FOUND"
    );
  }

  const commands = await queueEnvironmentSync({ serverId, userId, revision: environment.revision });

  if (commands.length === 0) {
    throw createError(
      "No hosting device is assigned to this server.",
      409,
      "NO_ASSIGNED_DEVICE"
    );
  }

  return res.status(202).json({
    success: true,
    message: "Environment synchronization queued.",
    data: {
      serverId,
      environmentRevision: environment.revision,
      queuedDevices: commands.length,
      commands,
    },
  });
};

module.exports = {
  getEnvironment,
  saveEnvironment,
  deleteEnvironmentVariable,
  syncEnvironment,
};
