const Notification = require("../models/notification.model");
const User = require("../models/user.model");
const Device = require("../models/device.model");

const { sendNotificationEmail, isNotificationEmailConfigured } = require("./email.service");
const { isPushConfigured, sendPush } = require("./push.service");

const EMAIL_SEVERITIES = new Set(["warning", "critical"]);

const emailEnabled = () =>
  process.env.NOTIFICATION_EMAIL_ENABLED !== "false" && isNotificationEmailConfigured();

const deliver = async (notification) => {
  const user = await User.findById(notification.userId)
    .select("name email isActive notificationPreferences")
    .lean();

  if (!user || !user.isActive) return;

  const preferences = user.notificationPreferences || {};
  const delivery = { email: "skipped", push: "skipped" };

  // Email is reserved for events that need attention.
  if (preferences.email !== false && emailEnabled() && EMAIL_SEVERITIES.has(notification.severity)) {
    try {
      await sendNotificationEmail({
        email: user.email,
        userName: user.name,
        title: notification.title,
        message: notification.message,
        severity: notification.severity,
      });
      delivery.email = "sent";
    } catch (error) {
      delivery.email = "failed";
      console.error("[SpareShare Notify] Email delivery failed:", error.message);
    }
  }

  if (preferences.push !== false && isPushConfigured()) {
    const devices = await Device.find({
      userId: notification.userId,
      isActive: true,
      fcmToken: { $type: "string", $ne: "" },
    }).select("+fcmToken");

    let sent = 0;
    let failed = 0;

    for (const device of devices) {
      try {
        const result = await sendPush({
          token: device.fcmToken,
          title: notification.title,
          body: notification.message,
          data: {
            notificationId: notification._id,
            type: notification.type,
            serverId: notification.serverId,
          },
        });
        if (result.sent) sent += 1;
        if (result.invalidToken) {
          await Device.updateOne({ _id: device._id }, { $unset: { fcmToken: 1 } });
        }
      } catch (error) {
        failed += 1;
        console.error("[SpareShare Notify] Push delivery failed:", error.message);
      }
    }

    if (devices.length > 0) delivery.push = sent > 0 ? "sent" : failed > 0 ? "failed" : "skipped";
  }

  await Notification.updateOne({ _id: notification._id }, { $set: { delivery } });
};

// Create an in-app notification and deliver it over the enabled channels.
// Never throws: a notification failure must not break the operation that
// raised it.
const notify = async ({
  userId,
  type,
  severity = "info",
  title,
  message,
  serverId = null,
  deviceId = null,
  data = {},
  dedupeKey,
  dedupeWindowMs = 0,
}) => {
  try {
    if (!userId) return null;

    if (dedupeKey && dedupeWindowMs > 0) {
      const duplicate = await Notification.exists({
        dedupeKey,
        createdAt: { $gt: new Date(Date.now() - dedupeWindowMs) },
      });
      if (duplicate) return null;
    }

    const notification = await Notification.create({
      userId,
      type,
      severity,
      title: String(title).slice(0, 150),
      message: String(message).slice(0, 1000),
      serverId,
      deviceId,
      data,
      dedupeKey,
    });

    deliver(notification).catch((error) => {
      console.error("[SpareShare Notify] Delivery failed:", error.message);
    });

    return notification;
  } catch (error) {
    console.error("[SpareShare Notify] Could not create notification:", error.message);
    return null;
  }
};

module.exports = { notify };
