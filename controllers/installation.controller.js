const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const mongoose = require("mongoose");

const Device = require("../models/device.model");
const Counter = require("../models/counter.model");
const UserSession = require("../models/userSession.model");
const { generateDownloadUrl } = require("../services/storage.service");


// Function to Download Debian ARM64 Rootfs.
const downloadRootfs = async (req, res, next) => {
  try {
    console.log("[ROOTFS] Download request received.");
    const rootfsPath = path.join(
      __dirname,
      "..",
      "storage",
      //"debian-arm64-rootfs-android.tar.gz"
      "debian-arm64-rootfs-android-backup.tar.gz"
    );
    console.log("[ROOTFS] Archive path:", rootfsPath);

    // Check if the Debian archive exists.
    if (!fs.existsSync(rootfsPath)) {
      console.log("[ROOTFS] Archive not found.");
      const error = new Error("Debian ARM64 rootfs archive not found.");
      error.statusCode = 404;
      error.code = "ROOTFS_NOT_FOUND";
      throw error;
    }

    console.log("[ROOTFS] Archive found.");
    // Get archive size for download progress on the client.
    const stat = await fs.promises.stat(rootfsPath);
    console.log("[ROOTFS] Archive size:", stat.size, "bytes");

    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Length", stat.size);
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="debian-arm64-rootfs-android-backup.tar.gz"'
    );
    console.log("[ROOTFS] Starting archive stream...");
    // Stream the archive instead of loading the entire 71 MB file into memory.
    const fileStream = fs.createReadStream(rootfsPath);
    fileStream.on("error", (error) => {
      console.error("[ROOTFS] Download stream failed:", error.message);
      if (!res.headersSent) {
        return next(error);
      }

      res.destroy(error);
    });

    fileStream.on("open", () => {console.log("[ROOTFS] File stream opened.");});
    fileStream.on("end", () => {console.log("[ROOTFS] Archive download completed.");});
    fileStream.pipe(res);

  } catch (error) {
    console.error("[ROOTFS] Controller error:", error.message);
    next(error);
  }
};


// Generate a sequential device ID inside the transaction
const generateDeviceId = async (session) => {
  const counter = await Counter.findByIdAndUpdate(
    "deviceId",
    { $inc: { sequence: 1 } },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
      session,
    }
  );

  return `DEVSS-${String(counter.sequence).padStart(6, "0")}`;
};


// Helper function to generate a unique device name based on manufacturer and model
const generateDeviceName = async ({userId, manufacturer, model, session, excludeDeviceId}) => {
  const baseName = [manufacturer, model]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim())
    .join(" ")
    .slice(0, 100)
    .trim() || "Android Device";

  const existingDevices = await Device.find({
    userId,
    ...(excludeDeviceId ? { _id: { $ne: excludeDeviceId } } : {}),
    name: {$regex: new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-\\d+)?$`,"i")}})
    .select("name")
    .session(session)
    .lean();

  const existingNames = new Set(existingDevices.map((device) => device.name.toLowerCase()));
  if (!existingNames.has(baseName.toLowerCase())) {
    return baseName;
  }
  let suffix = 2;
  while (existingNames.has(`${baseName}-${suffix}`.toLowerCase())) {
    suffix++;
  }
  return `${baseName}-${suffix}`;
};


// Device Info Fetching Function
const saveDeviceInfo = async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
    const userId = req.user?.userId;
    const sessionDbId = req.session?.dbId;

    if (!userId) {
      const error = new Error("Authentication is required.");
      error.statusCode = 401;
      error.code = "UNAUTHORIZED";
      throw error;
    }

    const {
      androidId,
      manufacturer,
      model,
      osName,
      osVersion,
      appVersion,
      architecture,
      totalRam,
      totalStorage,
      fcmToken,
      deviceType,
    } = req.body || {};

    if(typeof androidId !== "string" || !androidId.trim() || androidId.trim().length > 100) {
      const error = new Error("Android installation identifier is required.");
      error.statusCode = 400;
      error.code = "ANDROID_ID_REQUIRED";
      throw error;
    }

    const normalizedAndroidId = androidId.trim();

    // Reject malformed optional fields before touching the database.
    const textFields = { manufacturer, model, osName, osVersion, appVersion, architecture, fcmToken };
    for (const [field, value] of Object.entries(textFields)) {
      if (value !== undefined && value !== null && (typeof value !== "string" || value.length > (field === "fcmToken" ? 4096 : 100))) {
        const error = new Error(`${field} is invalid.`);
        error.statusCode = 400;
        error.code = "VALIDATION_ERROR";
        throw error;
      }
    }
    for (const [field, value] of Object.entries({ totalRam, totalStorage })) {
      if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        const error = new Error(`${field} must be a non-negative number.`);
        error.statusCode = 400;
        error.code = "VALIDATION_ERROR";
        throw error;
      }
    }

    // The app reports bytes. The schema stores megabytes.
    const toMb = (value) => (typeof value === "number" ? Math.round(value > 1e7 ? value / (1024 * 1024) : value) : undefined);
    const now = new Date();
    let device;

    await session.withTransaction(async () => {
      // Find an existing device belonging to this user
      const existingDevice = await Device.findOne({userId, androidId: normalizedAndroidId}).session(session);

      // A device keeps the name it already has. Only a new device is named.
      const deviceName = existingDevice
        ? undefined
        : await generateDeviceName({userId, manufacturer, model, session,});

      // Map incoming information to the Device schema
      const deviceInfo = {
        ...(deviceName !== undefined && {name: deviceName}),
        ...(osName !== undefined && {os: osName}),
        ...(osVersion !== undefined && {osVersion}),
        ...(architecture !== undefined && {architecture}),
        ...(appVersion !== undefined && {agentVersion: appVersion}),
        ...(manufacturer !== undefined && {manufacturer}),
        ...(model !== undefined && {model}),
        ...(typeof totalRam === "number" && {"hardware.memoryMb": toMb(totalRam)}),
        ...(typeof totalStorage === "number" && {"hardware.storageMb": toMb(totalStorage)}),
        ...(typeof fcmToken === "string" && fcmToken.trim() && {fcmToken: fcmToken.trim()}),
      };

      if (existingDevice) {
        // Update existing registration without consuming a new ID
        existingDevice.set(deviceInfo);
        // Presence is owned by the agent heartbeat. Opening the app does not
        // make a device "online" for hosting purposes.
        existingDevice.isActive = true;
        await existingDevice.save({ session });
        device = existingDevice;
      } 
      
      else {
        // Generate ID and create the device atomically
        const deviceId = await generateDeviceId(session);
        const [newDevice] = await Device.create(
          [
            {
              deviceId,
              userId,
              androidId: normalizedAndroidId,
              deviceType: "android",
              ...deviceInfo,
              status: "pending",
              isActive: true,
              registeredAt: now,
            },
          ],
          { session }
        );
        device = newDevice;
      }

      // updating the session to set the correct device ID
      if (sessionDbId) {
        await UserSession.findByIdAndUpdate(sessionDbId, { deviceId: device.deviceId }, { session });
      }

    });

    return res.status(200).json({
      success: true,
      message: "Device information saved successfully.",
      data: {
        id: device._id,
        deviceId: device.deviceId,
        deviceName: device.name,
        manufacturer: device.manufacturer,
        model: device.model,
        status: device.status,
        registeredAt: device.registeredAt,
        lastSeenAt: device.lastSeenAt,
      },
    });
  } catch (error) {
    next(error);
  } finally {
    await session.endSession();
  }
};



// Generate a secure download URL for a runtime/package archive.
const generateRuntimeDownload = (config) => {
  return async (req, res, next) => {
    try {
      console.log(`[RUNTIME] ${config.name} download request received.`);

      const objectKey = process.env[config.objectKeyEnv];

      if (!objectKey) {
        const error = new Error(
          `${config.name} archive is not configured.`
        );
        error.statusCode = 503;
        error.code = "RUNTIME_NOT_CONFIGURED";
        throw error;
      }

      const downloadUrl = await generateDownloadUrl({
        objectKey,
        filename: config.filename,
        expiresIn: 900,
      });

      return res.status(200).json({
        success: true,
        message: `${config.name} download URL generated successfully.`,
        data: {
          name: config.name,
          filename: config.filename,
          downloadUrl,
          expiresIn: 900,
        },
      });
    } catch (error) {
      console.error(
        `[RUNTIME] ${config.name} download error:`,
        error.message
      );
      next(error);
    }
  };
};


// Download pip archive.
const downloadPip = generateRuntimeDownload({
  name: "pip",
  objectKeyEnv: "B2_OBJECT_PIP",
  filename: "pip.pyz",
});


// Download npm archive.
const downloadNpm = generateRuntimeDownload({
  name: "npm",
  objectKeyEnv: "B2_OBJECT_NPM",
  filename: "node-v26.13.1-linux-arm64.tar.xz",
});


// Download JDK archive.
const downloadJdk = generateRuntimeDownload({
  name: "JDK",
  objectKeyEnv: "B2_OBJECT_JDK",
  filename: "OpenJDK25U-jdk_aarch64_linux_hotspot_25.0.5.1_2.tar.gz",
});

// Download Python archive.
const downloadPython = generateRuntimeDownload({
  name: "Python",
  objectKeyEnv: "B2_OBJECT_PYTHON",
  filename: "cpython-3.11.18+20261123-aarch64-unknown-linux-gnu-install_only.tar.gz",
});



module.exports = {
  saveDeviceInfo,
  downloadRootfs,
  generateDeviceName,
  
  downloadPip,
  downloadNpm,
  downloadJdk,
  downloadPython,
};
