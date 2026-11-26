const mongoose = require("mongoose");

const DEPLOYMENT_STATUSES = [
  "queued",
  "cloning",
  "detecting",
  "installing_runtime",
  "installing_dependencies",
  "building",
  "starting",
  "running",
  "failed",
  "cancelled",
  "superseded",
];

const IN_PROGRESS_STATUSES = DEPLOYMENT_STATUSES.slice(0, 7);
const FINAL_STATUSES = ["running", "failed", "cancelled", "superseded"];

const stepSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    status: { type: String, enum: ["running", "completed", "failed"], required: true },
    message: { type: String, maxlength: 2000 },
    startedAt: Date,
    finishedAt: Date,
  },
  { _id: false }
);

const deploymentSchema = new mongoose.Schema(
  {
    deploymentId: { type: String, required: true, unique: true, index: true },
    serverId: { type: mongoose.Schema.Types.ObjectId, ref: "Server", required: true, index: true },
    deviceId: { type: mongoose.Schema.Types.ObjectId, ref: "Device", required: true, index: true },
    triggeredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    trigger: {
      type: String,
      enum: ["manual", "webhook", "failover", "restore", "rollback"],
      default: "manual",
    },

    source: {
      type: { type: String, enum: ["git", "backup"], required: true },
      repositoryUrl: String,
      fullName: String,
      repositoryId: Number,
      installationId: Number,
      isPrivate: { type: Boolean, default: false },
      branch: String,
      commitSha: String,
      backupId: String,
    },

    status: { type: String, enum: DEPLOYMENT_STATUSES, default: "queued", index: true },

    // True while the deployment is in progress. A partial unique index on
    // this flag guarantees one in-flight deployment per server and device.
    isActive: { type: Boolean, default: true },

    idempotencyKey: { type: String, maxlength: 100 },
    commandId: String,
    steps: { type: [stepSchema], default: [] },
    detection: { type: mongoose.Schema.Types.Mixed, default: null },
    envRevision: { type: Number, default: 0 },
    error: { type: String, maxlength: 4000 },
    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true, versionKey: false }
);

deploymentSchema.index(
  { serverId: 1, deviceId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } }
);

deploymentSchema.index(
  { serverId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);

deploymentSchema.index({ serverId: 1, createdAt: -1 });

const Deployment =
  mongoose.models.Deployment || mongoose.model("Deployment", deploymentSchema);

module.exports = Deployment;
module.exports.DEPLOYMENT_STATUSES = DEPLOYMENT_STATUSES;
module.exports.IN_PROGRESS_STATUSES = IN_PROGRESS_STATUSES;
module.exports.FINAL_STATUSES = FINAL_STATUSES;
