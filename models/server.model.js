const mongoose = require("mongoose");

const serverSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },

    collaborators: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "User",
      required: true,
      index: true,
    },

    slug: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 120,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    status: {
      type: String,
      enum: [
        "creating",
        "stopped",
        "starting",
        "running",
        "stopping",
        "failed",
        "deleted",
      ],
      default: "creating",
      index: true,
    },

    visibility: {
      type: String,
      enum: ["private", "public"],
      default: "private",
    },

    port: {
      type: Number,
      min: 1,
      max: 65535,
    },

    environmentVersionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EnvironmentVersion",
    },

    uploadType: {
        type: String,
        enum: ["git", "zip"],
    },

    repository: {
      provider: {
        type: String,
        enum: [
          "github",
          "gitlab",
          "bitbucket",
          "other",
        ],
      },

      repositoryUrl: {
        type: String,
        trim: true,
      },

      branch: {
        type: String,
        trim: true,
        default: "main",
      },

      autoDeploy: {
        type: Boolean,
        default: false,
      },

      isPrivate: {
        type: Boolean,
        default: false,
      },

      // owner/name on the provider.
      fullName: {
        type: String,
        trim: true,
        maxlength: 200,
      },

      // GitHub numeric repository id and the App installation that grants access.
      repositoryId: {
        type: Number,
      },

      installationId: {
        type: Number,
      },
    },

    // Optional overrides for automatic detection.
    build: {
      rootDirectory: { type: String, trim: true, maxlength: 300, default: "" },
      installCommand: { type: String, trim: true, maxlength: 500 },
      buildCommand: { type: String, trim: true, maxlength: 500 },
      startCommand: { type: String, trim: true, maxlength: 500 },
      healthCheckPath: { type: String, trim: true, maxlength: 300, default: "/" },
    },

    // Result of the last automatic detection on a device.
    runtime: {
      language: String,
      framework: String,
      packageManager: String,
      runtimeVersion: String,
      // Port the application bound on the active device.
      port: Number,
      detectedAt: Date,
    },

    desiredState: {
      type: String,
      enum: ["running", "stopped"],
      default: "stopped",
    },

    // The device currently responsible for serving this server.
    activeDeviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Device",
      default: null,
      index: true,
    },

    currentDeploymentId: {
      type: String,
      default: null,
    },

    backup: {
      enabled: { type: Boolean, default: false },
      intervalHours: { type: Number, min: 1, max: 720, default: 24 },
      retentionCount: { type: Number, min: 1, max: 50, default: 5 },
      lastBackupAt: Date,
      lastScheduledAt: Date,
    },

    failover: {
      enabled: { type: Boolean, default: true },
      lastFailoverAt: Date,
    },

    resources: {
      cpuLimitPercent: {
        type: Number,
        min: 1,
        max: 100,
      },

      memoryLimitMb: {
        type: Number,
        min: 16,
      },

      storageLimitMb: {
        type: Number,
        min: 1,
      },
    },

    startedAt: {
      type: Date,
    },

    stoppedAt: {
      type: Date,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    
    monitoringEnabled: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

serverSchema.index(
  {
    owner: 1,
    slug: 1,
  },
  {
    unique: true,
  }
);

module.exports = mongoose.model("Server", serverSchema);
