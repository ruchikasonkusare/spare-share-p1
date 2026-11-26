const mongoose = require("mongoose");

const Device = require("../models/device.model");
const Counter = require("../models/counter.model");
const Server = require("../models/server.model");
const DeviceServer = require("../models/deviceServer.model");
const { DeviceAgentCredential } = require("../models/hostingRuntime.model");

const { createError } = require("../utils/errors");
const { readString, readEnum } = require("../utils/validate");
const { findUserDevice } = require("../services/server.service");
const {
  provisionAgentCredential,
  revokeAgentCredential,
  isDeviceOnline,
} = require("../services/hosting.service");

const MAX_DEVICES_PER_USER = Number(process.env.MAX_DEVICES_PER_USER) || 20;

const serializeDevice = (device, extra = {}) => ({
  id: device._id,
  deviceId: device.deviceId,
  name: device.name,
  deviceType: device.deviceType,
  manufacturer: device.manufacturer,
  model: device.model,
  os: device.os,
  osVersion: device.osVersion,
  architecture: device.architecture,
  agentVersion: device.agentVersion,
  hostname: device.hostname,
  // "online" is derived from the last heartbeat, not trusted from storage.
  status: !device.isActive ? "disabled" : isDeviceOnline(device) ? "online" : device.lastSeenAt ? "offline" : "pending",
  lastSeenAt: device.lastSeenAt || null,
  registeredAt: device.registeredAt,
  hardware: device.hardware || {},
  metrics: device.metrics || {},
  ...extra,
});

const listDevices = async (req, res) => {
  const devices = await Device.find({ userId: req.user.userId, isActive: true })
    .sort({ registeredAt: -1 })
    .lean();

  const ids = devices.map((device) => device._id);

  const [credentials, assignments] = await Promise.all([
    DeviceAgentCredential.find({ deviceId: { $in: ids }, isActive: true }).select("deviceId").lean(),
    DeviceServer.aggregate([
      { $match: { deviceId: { $in: ids }, status: { $ne: "removed" } } },
      { $group: { _id: "$deviceId", count: { $sum: 1 } } },
    ]),
  ]);

  const provisioned = new Set(credentials.map((item) => String(item.deviceId)));
  const counts = new Map(assignments.map((item) => [String(item._id), item.count]));

  return res.status(200).json({
    success: true,
    data: {
      devices: devices.map((device) =>
        serializeDevice(device, {
          agentProvisioned: provisioned.has(String(device._id)),
          serverCount: counts.get(String(device._id)) || 0,
        })
      ),
    },
  });
};

const getDevice = async (req, res) => {
  const device = await findUserDevice(req.user.userId, req.params.deviceId);

  const [credential, assignments] = await Promise.all([
    DeviceAgentCredential.findOne({ deviceId: device._id, isActive: true })
      .select("lastAuthenticatedAt tokenVersion")
      .lean(),
    DeviceServer.find({ deviceId: device._id, status: { $ne: "removed" } })
      .populate("serverId", "name slug status activeDeviceId")
      .lean(),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      device: serializeDevice(device, {
        agentProvisioned: Boolean(credential),
        agentLastAuthenticatedAt: credential ? credential.lastAuthenticatedAt || null : null,
      }),
      servers: assignments
        .filter((item) => item.serverId)
        .map((item) => ({
          serverId: item.serverId._id,
          name: item.serverId.name,
          slug: item.serverId.slug,
          status: item.serverId.status,
          role: item.role,
          priority: item.priority,
          assignmentStatus: item.status,
          isActiveDevice: String(item.serverId.activeDeviceId) === String(device._id),
        })),
    },
  });
};

// Register a non-Android host (Linux box, Raspberry Pi, VM). Android
// phones register through /api/setup/saveInfo.
const registerDevice = async (req, res) => {
  const body = req.body || {};
  const userId = req.user.userId;

  const name = readString(body.name, "Device name", { max: 100 });
  const deviceType = readEnum(
    body.deviceType || "linux",
    "deviceType",
    ["linux", "raspberry-pi", "windows", "macos", "other"]
  );
  const architecture = readString(body.architecture, "architecture", { required: false, max: 50 });
  const os = readString(body.os, "os", { required: false, max: 100 });

  const count = await Device.countDocuments({ userId, isActive: true });
  if (count >= MAX_DEVICES_PER_USER) {
    throw createError(`You can register at most ${MAX_DEVICES_PER_USER} devices.`, 409, "DEVICE_LIMIT_REACHED");
  }

  const session = await mongoose.startSession();
  let device;

  try {
    await session.withTransaction(async () => {
      const counter = await Counter.findByIdAndUpdate(
        "deviceId",
        { $inc: { sequence: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true, session }
      );

      const [created] = await Device.create(
        [{
          deviceId: `DEVSS-${String(counter.sequence).padStart(6, "0")}`,
          userId,
          name,
          deviceType,
          architecture,
          os,
          status: "pending",
          isActive: true,
        }],
        { session }
      );

      device = created;
    });
  } catch (error) {
    if (error.code === 11000) {
      throw createError("You already have a device with this name.", 409, "DEVICE_NAME_TAKEN");
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return res.status(201).json({
    success: true,
    message: "Device registered. Provision an agent token to connect it.",
    data: { device: serializeDevice(device, { agentProvisioned: false, serverCount: 0 }) },
  });
};

const updateDevice = async (req, res) => {
  const device = await findUserDevice(req.user.userId, req.params.deviceId);
  const name = readString((req.body || {}).name, "Device name", { max: 100 });

  device.name = name;

  try {
    await device.save();
  } catch (error) {
    if (error.code === 11000) {
      throw createError("You already have a device with this name.", 409, "DEVICE_NAME_TAKEN");
    }
    throw error;
  }

  return res.status(200).json({ success: true, data: { device: serializeDevice(device) } });
};

// Removing a device revokes its agent token and detaches it from every
// server. A device that is actively serving a running server is protected.
const removeDevice = async (req, res) => {
  const device = await findUserDevice(req.user.userId, req.params.deviceId);

  const serving = await Server.findOne({
    activeDeviceId: device._id,
    isActive: true,
    desiredState: "running",
  }).select("name");

  if (serving) {
    throw createError(
      `This device is serving "${serving.name}". Stop the server or fail it over first.`,
      409,
      "DEVICE_IN_USE"
    );
  }

  await revokeAgentCredential({ deviceId: device._id, reason: "device-removed" });
  await DeviceServer.updateMany({ deviceId: device._id }, { $set: { status: "removed" } });
  await Server.updateMany({ activeDeviceId: device._id }, { $set: { activeDeviceId: null } });

  // Free the unique (userId, name) and (userId, androidId) slots.
  device.isActive = false;
  device.status = "disabled";
  device.name = `${device.name.slice(0, 60)} (removed ${device.deviceId})`;
  device.androidId = undefined;
  await device.save();

  return res.status(200).json({
    success: true,
    message: "Device removed.",
    data: { id: device._id, deviceId: device.deviceId },
  });
};

const provisionAgent = async (req, res) => {
  const device = await findUserDevice(req.user.userId, req.params.deviceId);
  const credential = await provisionAgentCredential({ deviceId: String(device._id), userId: req.user.userId });

  res.set("Cache-Control", "no-store");

  return res.status(201).json({
    success: true,
    message: "Device agent credential generated. Store it securely; it will not be returned again.",
    data: credential,
  });
};

const revokeAgent = async (req, res) => {
  const device = await findUserDevice(req.user.userId, req.params.deviceId);
  await revokeAgentCredential({ deviceId: device._id });
  return res.status(200).json({ success: true, message: "Device agent credential revoked." });
};

module.exports = {
  serializeDevice,
  listDevices,
  getDevice,
  registerDevice,
  updateDevice,
  removeDevice,
  provisionAgent,
  revokeAgent,
};
