const crypto = require("crypto");

const ServerEndpoint = require("../models/serverEndpoint.model");
const { createError } = require("../utils/errors");

const createSlug = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

const getPublicBaseUrl = () => {
  const value = process.env.SPARESHARE_PUBLIC_BASE_URL;

  if (!value) {
    throw createError(
      "SPARESHARE_PUBLIC_BASE_URL is not configured.",
      500,
      "PUBLIC_BASE_URL_NOT_CONFIGURED"
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw createError("SPARESHARE_PUBLIC_BASE_URL is invalid.", 500, "INVALID_PUBLIC_BASE_URL");
  }

  if (parsed.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw createError("The public endpoint base URL must use HTTPS.", 500, "PUBLIC_HTTPS_REQUIRED");
  }

  return value.replace(/\/+$/, "");
};

const generatePermanentId = (slug) =>
  `${createSlug(slug) || "server"}-${crypto.randomBytes(5).toString("hex")}`;

// The permanent URL is derived from the stored id on every read, so moving
// the API to a new public host does not strand existing endpoints.
const resolvePermanentId = (endpoint) => {
  if (endpoint.permanentId) return endpoint.permanentId;
  const link = String(endpoint.permanentLink || "");
  return link.slice(link.lastIndexOf("/") + 1);
};

const buildPermanentLink = (endpoint) =>
  `${getPublicBaseUrl()}/s/${resolvePermanentId(endpoint)}`;

const findEndpointByPermanentId = async (permanentId) => {
  const base = getPublicBaseUrl().toLowerCase();
  return ServerEndpoint.findOne({
    isActive: true,
    $or: [
      { permanentId },
      // Endpoints created before permanentId existed.
      { permanentLink: `${base}/${permanentId}` },
      { permanentLink: `${base}/s/${permanentId}` },
    ],
  });
};

// Every server gets exactly one endpoint. Safe under concurrency: the
// unique index on serverId turns a lost race into a re-read.
const ensureServerEndpoint = async (server) => {
  const existing = await ServerEndpoint.findOne({ serverId: server._id });
  if (existing) return existing;

  const permanentId = generatePermanentId(server.slug || server.name);

  try {
    return await ServerEndpoint.create({
      serverId: server._id,
      permanentId,
      permanentLink: `${getPublicBaseUrl()}/s/${permanentId}`,
      redirectionLinks: [],
      routingMode: "proxy",
      isActive: true,
      configVersion: 1,
    });
  } catch (error) {
    if (error.code === 11000) {
      const raced = await ServerEndpoint.findOne({ serverId: server._id });
      if (raced) return raced;
    }
    throw error;
  }
};

module.exports = {
  createSlug,
  getPublicBaseUrl,
  generatePermanentId,
  resolvePermanentId,
  buildPermanentLink,
  findEndpointByPermanentId,
  ensureServerEndpoint,
};
