const mongoose = require("mongoose");

const githubInstallationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // One GitHub installation can be linked to more than one SpareShare
    // account (two people in the same organisation, for example), so the
    // pair is unique, not the installation on its own.
    installationId: {
      type: Number,
      required: true,
      index: true,
    },

    accountId: {
      type: Number,
      required: true,
    },

    accountLogin: {
      type: String,
      required: true,
      trim: true,
    },

    accountType: {
      type: String,
      enum: ["User", "Organization"],
      required: true,
    },

    repositorySelection: {
      type: String,
      enum: ["all", "selected"],
      required: true,
    },

    status: {
      type: String,
      enum: ["active", "suspended", "uninstalled"],
      default: "active",
      index: true,
    },

    permissions: {
      contents: {
        type: String,
        default: "read",
      },
      metadata: {
        type: String,
        default: "read",
      },
    },

    installedAt: {
      type: Date,
      default: Date.now,
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

githubInstallationSchema.index({ userId: 1, installationId: 1 }, { unique: true });

// Databases created before installations could be shared still carry a
// unique index on installationId. It is replaced here once.
githubInstallationSchema.statics.migrateIndexes = async function () {
  try {
    const indexes = await this.collection.indexes();
    const old = indexes.find(
      (index) => index.name === "installationId_1" && index.unique
    );
    if (old) await this.collection.dropIndex("installationId_1");
  } catch (error) {
    // The collection does not exist yet: nothing to migrate.
    if (error.codeName !== "NamespaceNotFound") throw error;
  }
  await this.createIndexes();
};

module.exports = mongoose.model(
  "GitHubInstallation",
  githubInstallationSchema
);
