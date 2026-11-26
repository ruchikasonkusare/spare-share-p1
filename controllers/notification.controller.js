const Notification = require("../models/notification.model");

const { createError } = require("../utils/errors");
const { isObjectId, readInt } = require("../utils/validate");

const serialize = (item) => ({
  id: item._id,
  type: item.type,
  severity: item.severity,
  title: item.title,
  message: item.message,
  serverId: item.serverId,
  deviceId: item.deviceId,
  data: item.data || {},
  read: Boolean(item.readAt),
  readAt: item.readAt || null,
  createdAt: item.createdAt,
});

const listNotifications = async (req, res) => {
  const limit = readInt(req.query.limit, "limit", { required: false, min: 1, max: 100 }) || 30;
  const filter = { userId: req.user.userId };

  if (req.query.unread === "true") filter.readAt = null;

  if (req.query.before !== undefined) {
    if (!isObjectId(req.query.before)) {
      throw createError("before is not a valid cursor.", 400, "VALIDATION_ERROR");
    }
    filter._id = { $lt: req.query.before };
  }

  const [items, unread] = await Promise.all([
    Notification.find(filter).sort({ _id: -1 }).limit(limit).lean(),
    Notification.countDocuments({ userId: req.user.userId, readAt: null }),
  ]);

  return res.status(200).json({
    success: true,
    data: {
      unread,
      notifications: items.map(serialize),
      nextCursor: items.length === limit ? items[items.length - 1]._id : null,
    },
  });
};

const getUnreadCount = async (req, res) => {
  const unread = await Notification.countDocuments({ userId: req.user.userId, readAt: null });
  return res.status(200).json({ success: true, data: { unread } });
};

const markRead = async (req, res) => {
  if (!isObjectId(req.params.notificationId)) {
    throw createError("Invalid notification ID.", 400, "INVALID_NOTIFICATION_ID");
  }

  // Filtering on readAt keeps a repeated request from changing the timestamp.
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.notificationId, userId: req.user.userId },
    [{ $set: { readAt: { $ifNull: ["$readAt", "$$NOW"] } } }],
    { new: true, updatePipeline: true }
  );

  if (!notification) {
    throw createError("Notification not found.", 404, "NOTIFICATION_NOT_FOUND");
  }

  return res.status(200).json({ success: true, data: { notification: serialize(notification) } });
};

const markAllRead = async (req, res) => {
  const result = await Notification.updateMany(
    { userId: req.user.userId, readAt: null },
    { $set: { readAt: new Date() } }
  );

  return res.status(200).json({ success: true, data: { updated: result.modifiedCount } });
};

const deleteNotification = async (req, res) => {
  if (!isObjectId(req.params.notificationId)) {
    throw createError("Invalid notification ID.", 400, "INVALID_NOTIFICATION_ID");
  }

  const result = await Notification.deleteOne({
    _id: req.params.notificationId,
    userId: req.user.userId,
  });

  if (result.deletedCount === 0) {
    throw createError("Notification not found.", 404, "NOTIFICATION_NOT_FOUND");
  }

  return res.status(200).json({ success: true, message: "Notification deleted." });
};

module.exports = { listNotifications, getUnreadCount, markRead, markAllRead, deleteNotification };
