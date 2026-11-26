const Server = require("../models/server.model");
const Device = require("../models/device.model");
const GitHubInstallation = require("../models/githubInstallation.model");

const { createError } = require("../utils/errors");
const { isObjectId, isPlainObject, readString, readBoolean } = require("../utils/validate");
const { isPrivateHostname, allowPrivateDestinations } = require("../utils/network");
const { BRANCH_PATTERN } = require("./deployment.service");
const github = require("./github.service");

const getOwnedServer = async (userId, serverId) => {
  if (!isObjectId(serverId)) {
    throw createError("Invalid server ID.", 400, "INVALID_SERVER_ID");
  }

  const server = await Server.findOne({
    _id: serverId,
    owner: userId,
    isActive: true,
    status: { $ne: "deleted" },
  });

  if (!server) {
    throw createError(
      "Server not found or you do not have permission to manage it.",
      404,
      "SERVER_NOT_FOUND"
    );
  }

  return server;
};

// Accepts either the database id or the public DEVSS-000001 identifier.
const findUserDevice = async (userId, idOrPublicId, { includeInactive = false } = {}) => {
  if (typeof idOrPublicId !== "string" || !idOrPublicId.trim()) {
    throw createError("Invalid device identifier.", 400, "INVALID_DEVICE_ID");
  }

  const value = idOrPublicId.trim();
  const filter = { userId };

  if (isObjectId(value)) {
    filter._id = value;
  } else if (/^DEVSS-\d{1,12}$/i.test(value)) {
    filter.deviceId = value.toUpperCase();
  } else {
    throw createError("Invalid device identifier.", 400, "INVALID_DEVICE_ID");
  }

  if (!includeInactive) filter.isActive = true;

  const device = await Device.findOne(filter);

  if (!device) {
    throw createError("Device not found for this account.", 404, "DEVICE_NOT_FOUND");
  }

  return device;
};

const GITHUB_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
const FULL_NAME_PATTERN = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

// Validate and normalise the repository block of a server. For GitHub the
// repository is resolved through the owner's App installation, falling
// back to an unauthenticated lookup for public repositories.
const resolveRepository = async ({ userId, input }) => {
  if (input === undefined || input === null) return undefined;

  if (!isPlainObject(input)) {
    throw createError("repository must be an object.", 400, "INVALID_REPOSITORY");
  }

  const branch = readString(input.branch, "Repository branch", { required: false, max: 200 });
  if (branch && !BRANCH_PATTERN.test(branch)) {
    throw createError("Branch name is invalid.", 400, "INVALID_BRANCH");
  }

  const autoDeploy = readBoolean(input.autoDeploy, "autoDeploy", { required: false }) ?? false;
  const rawUrl = readString(input.repositoryUrl, "Repository URL", { required: false, max: 500 });
  let fullName = readString(input.fullName, "Repository name", { required: false, max: 200 });

  const githubMatch = rawUrl ? rawUrl.match(GITHUB_URL_PATTERN) : null;
  if (!fullName && githubMatch) fullName = `${githubMatch[1]}/${githubMatch[2]}`;

  const provider = input.provider || (fullName || githubMatch ? "github" : "other");

  if (!["github", "gitlab", "bitbucket", "other"].includes(provider)) {
    throw createError("Unsupported repository provider.", 400, "INVALID_REPOSITORY_PROVIDER");
  }

  if (provider === "github") {
    if (!fullName || !FULL_NAME_PATTERN.test(fullName)) {
      throw createError(
        "Provide the GitHub repository as owner/name or as a github.com URL.",
        400,
        "INVALID_REPOSITORY"
      );
    }

    let repo = null;
    let installationId;

    if (github.isGitHubAppConfigured()) {
      const installations = await GitHubInstallation.find({ userId, status: "active" });
      for (const installation of installations) {
        repo = await github.getInstallationRepository(installation.installationId, fullName);
        if (repo) {
          installationId = installation.installationId;
          break;
        }
      }
    }

    if (!repo) repo = await github.getPublicRepository(fullName);

    if (!repo) {
      throw createError(
        "Repository not found. If it is private, connect GitHub and grant SpareShare access to it.",
        404,
        "REPOSITORY_NOT_ACCESSIBLE"
      );
    }

    return {
      provider: "github",
      repositoryUrl: repo.cloneUrl,
      fullName: repo.fullName,
      repositoryId: repo.id,
      installationId: repo.private ? installationId : undefined,
      isPrivate: repo.private,
      branch: branch || repo.defaultBranch || "main",
      autoDeploy,
    };
  }

  // Any other Git host: public HTTPS clone URL only.
  if (!rawUrl) {
    throw createError("Repository URL is required.", 400, "INVALID_REPOSITORY");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw createError("Repository URL is not a valid URL.", 400, "INVALID_REPOSITORY");
  }

  // Development only: a Git remote served from this machine.
  const localRemote =
    allowPrivateDestinations() &&
    ["http:", "https:"].includes(parsed.protocol) &&
    ["127.0.0.1", "localhost"].includes(parsed.hostname) &&
    !parsed.username && !parsed.password;

  if (!localRemote && (parsed.protocol !== "https:" || parsed.username || parsed.password || isPrivateHostname(parsed.hostname))) {
    throw createError(
      "Repository URL must be a public HTTPS URL without embedded credentials.",
      400,
      "INVALID_REPOSITORY"
    );
  }

  return {
    provider,
    repositoryUrl: parsed.toString(),
    fullName: fullName || parsed.pathname.replace(/^\/|\.git$|\/$/g, ""),
    isPrivate: false,
    branch: branch || "main",
    autoDeploy,
  };
};

const COMMAND_FIELDS = ["installCommand", "buildCommand", "startCommand"];

const resolveBuildSettings = (input) => {
  if (input === undefined || input === null) return undefined;

  if (!isPlainObject(input)) {
    throw createError("build must be an object.", 400, "INVALID_BUILD_SETTINGS");
  }

  const build = {};

  if (input.rootDirectory !== undefined) {
    const root = String(input.rootDirectory || "").trim().replace(/^\/+|\/+$/g, "");
    if (root.length > 300 || root.split("/").includes("..") || /[\0\n\r]/.test(root)) {
      throw createError("Root directory is invalid.", 400, "INVALID_ROOT_DIRECTORY");
    }
    build.rootDirectory = root;
  }

  for (const field of COMMAND_FIELDS) {
    if (input[field] === undefined) continue;
    if (input[field] === null || input[field] === "") {
      build[field] = undefined;
      continue;
    }
    const command = readString(input[field], field, { max: 500 });
    if (/[\0\n\r]/.test(command)) {
      throw createError(`${field} must be a single line.`, 400, "INVALID_BUILD_COMMAND");
    }
    build[field] = command;
  }

  if (input.healthCheckPath !== undefined) {
    const healthPath = readString(input.healthCheckPath, "Health check path", { max: 300 });
    if (!healthPath.startsWith("/") || /[\s\0]/.test(healthPath)) {
      throw createError("Health check path must start with / and contain no spaces.", 400, "INVALID_HEALTH_CHECK_PATH");
    }
    build.healthCheckPath = healthPath;
  }

  return build;
};

module.exports = { getOwnedServer, findUserDevice, resolveRepository, resolveBuildSettings };
