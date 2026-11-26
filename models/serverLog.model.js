const mongoose = require("mongoose");

const LOG_RETENTION_DAYS = Math.max(1, Number(process.env.LOG_RETENTION_DAYS) || 7);

const serverLogSchema = new mongoose.Schema(
  {
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: "Server", required: true },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Device", required: true },
    deploymentId: { type: String, default: null },
    stream: { type: String, enum: ["app", "build", "tunnel", "agent"], required: true },
    level: { type: String, enum: ["info", "warn", "error"], default: "info" },
    message: { type: String, required: true, maxlength: 4000 },
    ts: { type: Date, required: true },
  },
  { versionKey: false }
);

serverLogSchema.index({ serverId: 1, _id: -1 });
serverLogSchema.index({ serverId: 1, stream: 1, _id: -1 });
serverLogSchema.index({ ts: 1 }, { expireAfterSeconds: LOG_RETENTION_DAYS * 24 * 60 * 60 });

module.exports = mongoose.models.ServerLog || mongoose.model("ServerLog", serverLogSchema);
