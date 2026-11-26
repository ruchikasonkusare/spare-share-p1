const mongoose = require("mongoose");

const backupSchema = new mongoose.Schema(
  {
    backupId: { type: String, required: true, unique: true, index: true },
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: "Server", required: true, index: true },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Device", required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    deploymentId: { type: String, default: null },

    trigger: { type: String, enum: ["manual", "scheduled"], default: "manual" },

    status: {
      type: String,
      enum: ["pending", "uploading", "completed", "failed", "deleted"],
      default: "pending",
      index: true,
    },

    storage: {
      driver: { type: String, enum: ["local", "s3"], required: true },
      key: { type: String, required: true },
    },

    sizeBytes: { type: Number, min: 0, default: 0 },
    sha256: { type: String, match: /^[a-f0-9]{64}$/ },
    envRevision: { type: Number, default: 0 },
    commitSha: String,
    commandId: String,
    error: { type: String, maxlength: 2000 },
    completedAt: Date,
  },
  { timestamps: true, versionKey: false }
);

backupSchema.index({ serverId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.models.Backup || mongoose.model("Backup", backupSchema);
