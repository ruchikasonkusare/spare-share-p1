const mongoose = require("mongoose");

const failoverEventSchema = new mongoose.Schema(
  {
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: "Server", required: true },
    fromDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Device", default: null },
    toDeviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Device", required: true },
    trigger: { type: String, enum: ["automatic", "manual"], required: true },
    reason: { type: String, maxlength: 500 },
    strategy: { type: String, enum: ["backup", "git"], required: true },
    deploymentId: String,
    backupId: String,

    status: {
      type: String,
      enum: ["deploying", "awaiting_tunnel", "completed", "failed"],
      default: "deploying",
    },

    // True while the failover is unresolved; one per server at a time.
    inProgress: { type: Boolean, default: true },

    error: { type: String, maxlength: 2000 },
    startedAt: { type: Date, default: Date.now },
    completedAt: Date,
  },
  { timestamps: true, versionKey: false }
);

failoverEventSchema.index(
  { serverId: 1 },
  { unique: true, partialFilterExpression: { inProgress: true } }
);

failoverEventSchema.index({ serverId: 1, createdAt: -1 });

module.exports =
  mongoose.models.FailoverEvent || mongoose.model("FailoverEvent", failoverEventSchema);
