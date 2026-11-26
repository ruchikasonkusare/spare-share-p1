const mongoose = require("mongoose");

const NOTIFICATION_RETENTION_DAYS = Math.max(1, Number(process.env.NOTIFICATION_RETENTION_DAYS) || 60);

const deliverySchema = {
  type: String,
  enum: ["pending", "sent", "failed", "skipped"],
  default: "skipped",
};

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, required: true, maxlength: 60, index: true },
    severity: { type: String, enum: ["info", "success", "warning", "critical"], default: "info" },
    title: { type: String, required: true, maxlength: 150 },
    message: { type: String, required: true, maxlength: 1000 },
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: "Server", default: null },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Device", default: null },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    dedupeKey: { type: String, maxlength: 200 },
    readAt: { type: Date, default: null },
    delivery: { email: deliverySchema, push: deliverySchema },
  },
  { timestamps: true, versionKey: false }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index({ dedupeKey: 1, createdAt: -1 });
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 }
);

module.exports =
  mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
