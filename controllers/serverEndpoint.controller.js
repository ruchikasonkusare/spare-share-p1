const mongoose = require("mongoose");
const httpProxy = require("http-proxy");

const Server = require("../models/server.model");
const ServerEndpoint = require("../models/serverEndpoint.model");
const MonitoringData = require("../models/monitoringData.model");

const { allowPrivateDestinations, isPrivateHostname } = require("../utils/network");
const { createRateLimiter } = require("../middlewares/rateLimit.middleware");
const {
  getPublicBaseUrl,
  buildPermanentLink,
  resolvePermanentId,
  findEndpointByPermanentId,
  ensureServerEndpoint,
} = require("../services/endpoint.service");

// Present an endpoint with its permanent URL derived from the current
// public base URL.
const presentEndpoint = (endpoint) => {
  const plain = typeof endpoint.toObject === "function" ? endpoint.toObject() : endpoint;
  return {
    ...plain,
    permanentId: resolvePermanentId(plain),
    permanentLink: buildPermanentLink(plain),
  };
};

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  xfwd: true,
  secure: true,
  proxyTimeout: 30000,
  timeout: 30000,
  prependPath: false,
  cookieDomainRewrite: "",
});

// Create consistent application errors
const createError = (message, statusCode, code) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

// Validate MongoDB ObjectId
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// Handle database and validation errors
const handleEndpointError = (error, next) => {
  if (error.code === 11000) {
    return next(
      createError(
        "A server endpoint with this identifier already exists.",
        409,
        "SERVER_ENDPOINT_ALREADY_EXISTS"
      )
    );
  }

  if (error.name === "ValidationError") {
    return next(
      createError(error.message, 400, "VALIDATION_ERROR")
    );
  }

  return next(error);
};

// Get authenticated user ID
const getUserId = (req) => {
  const userId = req.user?.userId;

  if (!userId) {
    throw createError(
      "Authentication is required.",
      401,
      "UNAUTHORIZED"
    );
  }

  if (!isValidObjectId(userId)) {
    throw createError(
      "Invalid authenticated user ID.",
      401,
      "INVALID_USER_ID"
    );
  }

  return userId;
};

// Normalize slug
const createSlug = (value) => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
};

// Validate destination URL
const validateDestinationLink = (value, httpsOnly = true) => {
  if (typeof value !== "string" || !value.trim()) {
    throw createError(
      "A valid destination link is required.",
      400,
      "INVALID_DESTINATION_LINK"
    );
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(value.trim());
  } catch {
    throw createError(
      "The destination link is not a valid URL.",
      400,
      "INVALID_DESTINATION_LINK"
    );
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw createError(
      "Only HTTP and HTTPS destinations are supported.",
      400,
      "INVALID_DESTINATION_PROTOCOL"
    );
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw createError(
      "Destination URLs cannot contain embedded credentials.",
      400,
      "INVALID_DESTINATION_CREDENTIALS"
    );
  }

  // Development only: loopback destinations registered by a local agent.
  if (
    allowPrivateDestinations() &&
    ["127.0.0.1", "localhost"].includes(parsedUrl.hostname)
  ) {
    return parsedUrl.toString();
  }

  if (httpsOnly && parsedUrl.protocol !== "https:") {
    throw createError(
      "HTTPS destination links are required.",
      400,
      "HTTPS_REQUIRED"
    );
  }

  // Reject loopback, private, link-local and internal destinations so the
  // proxy cannot be pointed at the API server's own network.
  if (isPrivateHostname(parsedUrl.hostname)) {
    throw createError(
      "Local, private and internal destinations are not allowed.",
      400,
      "INVALID_DESTINATION_HOST"
    );
  }

  return parsedUrl.toString();
};

// Increment routing configuration version
const updateConfigVersion = (endpoint) => {
  endpoint.configVersion = (endpoint.configVersion || 1) + 1;
};


const normalizeEndpointPath = (path) => {
  return path
    .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, "/:id")
    .replace(/\/\d+(?=\/|$)/g, "/:id");
};

const recordProxyTraffic = async ({
  serverId,
  method,
  path,
  statusCode,
  durationMs,
  bytesIn,
  bytesOut,
}) => {
  try {
    const now = new Date();

    const minute = new Date(now);
    minute.setSeconds(0, 0);

    const successful = statusCode >= 200 && statusCode < 400;
    const failed = statusCode >= 400;

    const normalizedMethod = method.toUpperCase();
    const normalizedPath = normalizeEndpointPath(path);

    // Ensure the monitoring document exists.
    // Do not refresh lastHeartbeatAt from proxy traffic.
    await MonitoringData.updateOne(
      { serverId },
      {
        $setOnInsert: {
          serverId,
          health: "unknown",
          lastHeartbeatAt: now,
        },
      },
      { upsert: true }
    );

    // Update cumulative traffic counters.
    const increments = {
      "traffic.totalRequests": 1,
      "traffic.bytesIn": bytesIn,
      "traffic.bytesOut": bytesOut,
      "traffic.totalResponseTimeMs": durationMs,
      [`traffic.methods.${normalizedMethod}`]: 1,
    };

    if (successful) {
      increments["traffic.successfulRequests"] = 1;
    }

    if (failed) {
      increments["traffic.failedRequests"] = 1;
    }

    await MonitoringData.updateOne(
      { serverId },
      { $inc: increments }
    );

    // Update or create the current minute bucket.
    const existingBucket = await MonitoringData.exists({
      serverId,
      "traffic.minuteBuckets.minute": minute,
    });

    const bucketIncrement = {
      "traffic.minuteBuckets.$.requests": 1,
      "traffic.minuteBuckets.$.bytesIn": bytesIn,
      "traffic.minuteBuckets.$.bytesOut": bytesOut,
      "traffic.minuteBuckets.$.responseTimeMs": durationMs,
    };

    if (successful) {
      bucketIncrement[
        "traffic.minuteBuckets.$.successfulRequests"
      ] = 1;
    }

    if (failed) {
      bucketIncrement[
        "traffic.minuteBuckets.$.failedRequests"
      ] = 1;
    }

    if (existingBucket) {
      await MonitoringData.updateOne(
        {
          serverId,
          "traffic.minuteBuckets.minute": minute,
        },
        { $inc: bucketIncrement }
      );
    } else {
      await MonitoringData.updateOne(
        { serverId },
        {
          $push: {
            "traffic.minuteBuckets": {
              $each: [
                {
                  minute,
                  requests: 1,
                  successfulRequests: successful ? 1 : 0,
                  failedRequests: failed ? 1 : 0,
                  bytesIn,
                  bytesOut,
                  responseTimeMs: durationMs,
                },
              ],
              $slice: -60,
            },
          },
        }
      );
    }

    // Update or create endpoint statistics.
    const existingEndpoint = await MonitoringData.exists({
      serverId,
      "traffic.endpointStats.method": normalizedMethod,
      "traffic.endpointStats.path": normalizedPath,
    });

    if (existingEndpoint) {
      const endpointIncrement = {
        "traffic.endpointStats.$.requests": 1,
        "traffic.endpointStats.$.totalResponseTimeMs": durationMs,
      };

      if (successful) {
        endpointIncrement[
          "traffic.endpointStats.$.successfulRequests"
        ] = 1;
      }

      if (failed) {
        endpointIncrement[
          "traffic.endpointStats.$.failedRequests"
        ] = 1;
      }

      await MonitoringData.updateOne(
        {
          serverId,
          "traffic.endpointStats.method": normalizedMethod,
          "traffic.endpointStats.path": normalizedPath,
        },
        {
          $inc: endpointIncrement,
          $set: {
            "traffic.endpointStats.$.lastCalledAt": now,
          },
        }
      );
    } else {
      await MonitoringData.updateOne(
        { serverId },
        {
          $push: {
            "traffic.endpointStats": {
              $each: [
                {
                  method: normalizedMethod,
                  path: normalizedPath,
                  requests: 1,
                  successfulRequests: successful ? 1 : 0,
                  failedRequests: failed ? 1 : 0,
                  totalResponseTimeMs: durationMs,
                  lastCalledAt: now,
                },
              ],
              $slice: -100,
            },
          },
        }
      );
    }
  } catch (error) {
    // Monitoring failure must not interrupt customer traffic.
    console.error("Proxy traffic monitoring failed:", error.message);
  }
};


// Verify server ownership
const getOwnedServer = async (userId, serverId) => {
  if (!isValidObjectId(serverId)) {
    throw createError(
      "Invalid server ID.",
      400,
      "INVALID_SERVER_ID"
    );
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

// Get owned endpoint
const getOwnedEndpoint = async (userId, serverId) => {
  const server = await getOwnedServer(userId, serverId);

  const endpoint = await ServerEndpoint.findOne({
    serverId: server._id,
  });

  if (!endpoint) {
    throw createError(
      "Server endpoint not found.",
      404,
      "SERVER_ENDPOINT_NOT_FOUND"
    );
  }

  return { server, endpoint };
};

// Find a mapping
const findMappingIndex = (endpoint, deviceId, userId) => {
  return endpoint.redirectionLinks.findIndex((link) => {
    return (
      link.deviceId.toString() === deviceId &&
      link.userId.toString() === userId
    );
  });
};

// CREATE SERVER ENDPOINT
const createServerEndpoint = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { serverId } = req.params;
    const { redirectionLinks, routingMode } = req.body;

    const server = await getOwnedServer(userId, serverId);

    if (
      routingMode !== undefined &&
      !["redirect", "proxy"].includes(routingMode)
    ) {
      throw createError(
        "Invalid routing mode.",
        400,
        "INVALID_ROUTING_MODE"
      );
    }

    if (
      redirectionLinks !== undefined &&
      !Array.isArray(redirectionLinks)
    ) {
      throw createError(
        "Redirection links must be an array.",
        400,
        "INVALID_REDIRECTION_LINKS"
      );
    }

    const normalizedLinks = (redirectionLinks || []).map((link) => {
      if (!isValidObjectId(link.userId)) {
        throw createError(
          "Invalid mapped user ID.",
          400,
          "INVALID_MAPPED_USER_ID"
        );
      }

      if (!isValidObjectId(link.deviceId)) {
        throw createError(
          "Invalid device ID.",
          400,
          "INVALID_DEVICE_ID"
        );
      }

      if (
        link.priority !== undefined &&
        (!Number.isInteger(link.priority) || link.priority < 1)
      ) {
        throw createError(
          "Priority must be a positive integer.",
          400,
          "INVALID_PRIORITY"
        );
      }

      return {
        userId: link.userId,
        deviceId: link.deviceId,
        destinationLink: validateDestinationLink(link.destinationLink),
        priority: link.priority ?? 1,
        isActive: link.isActive ?? true,
      };
    });

    // A server has exactly one endpoint and it is created with the server.
    // This call configures it and is safe to repeat.
    const endpoint = await ensureServerEndpoint(server);

    if (routingMode !== undefined) {
      endpoint.routingMode = routingMode;
    }

    if (normalizedLinks.length > 0) {
      for (const link of normalizedLinks) {
        const duplicate = endpoint.redirectionLinks.some(
          (item) =>
            String(item.userId) === String(link.userId) &&
            String(item.deviceId) === String(link.deviceId)
        );

        if (!duplicate) {
          endpoint.redirectionLinks.push(link);
        }
      }
    }

    if (endpoint.isModified()) {
      updateConfigVersion(endpoint);
      await endpoint.save();
    }

    return res.status(201).json({
      success: true,
      message: "Server endpoint is ready.",
      data: { endpoint: presentEndpoint(endpoint) },
    });
  } catch (error) {
    return handleEndpointError(error, next);
  }
};

// GET SERVER ENDPOINT
const getServerEndpoint = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { serverId } = req.params;

    const { endpoint } = await getOwnedEndpoint(
      userId,
      serverId
    );

    return res.status(200).json({
      success: true,
      message: "Server endpoint fetched successfully.",
      data: { endpoint: presentEndpoint(endpoint) },
    });
  } catch (error) {
    return next(error);
  }
};

// GET ALL SERVER ENDPOINTS
const getServerEndpoints = async (req, res, next) => {
  try {
    const userId = getUserId(req);

    const servers = await Server.find({
      owner: userId,
      isActive: true,
      status: { $ne: "deleted" },
    }).select("_id");

    const serverIds = servers.map((server) => server._id);

    const endpoints = await ServerEndpoint.find({
      serverId: { $in: serverIds },
    })
      .populate("serverId", "name slug status")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "Server endpoints fetched successfully.",
      data: { endpoints: endpoints.map(presentEndpoint) },
    });
  } catch (error) {
    return next(error);
  }
};

// ADD REDIRECTION LINK
const addRedirectionLink = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { serverId } = req.params;

    const {
      userId: mappedUserId,
      deviceId,
      destinationLink,
      priority,
    } = req.body;

    const { endpoint } = await getOwnedEndpoint(
      userId,
      serverId
    );

    if (!isValidObjectId(mappedUserId)) {
      throw createError(
        "Invalid mapped user ID.",
        400,
        "INVALID_MAPPED_USER_ID"
      );
    }

    if (!isValidObjectId(deviceId)) {
      throw createError(
        "Invalid device ID.",
        400,
        "INVALID_DEVICE_ID"
      );
    }

    if (
      priority !== undefined &&
      (!Number.isInteger(priority) || priority < 1)
    ) {
      throw createError(
        "Priority must be a positive integer.",
        400,
        "INVALID_PRIORITY"
      );
    }

    const duplicate = endpoint.redirectionLinks.some(
      (link) =>
        link.userId.toString() === mappedUserId &&
        link.deviceId.toString() === deviceId
    );

    if (duplicate) {
      throw createError(
        "A mapping already exists for this user and device.",
        409,
        "REDIRECTION_LINK_ALREADY_EXISTS"
      );
    }

    endpoint.redirectionLinks.push({
      userId: mappedUserId,
      deviceId,
      destinationLink: validateDestinationLink(
        destinationLink,
        endpoint.security.httpsOnly
      ),
      priority: priority ?? 1,
      isActive: true,
    });

    updateConfigVersion(endpoint);

    await endpoint.save();

    return res.status(201).json({
      success: true,
      message: "Redirection link added successfully.",
      data: {
        redirectionLinks: endpoint.redirectionLinks,
        configVersion: endpoint.configVersion,
      },
    });
  } catch (error) {
    return handleEndpointError(error, next);
  }
};

// UPDATE REDIRECTION LINK
const updateRedirectionLink = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { serverId, deviceId } = req.params;
    const { userId: mappedUserId } = req.query;

    if (!isValidObjectId(deviceId)) {
      throw createError(
        "Invalid device ID.",
        400,
        "INVALID_DEVICE_ID"
      );
    }

    if (!isValidObjectId(mappedUserId)) {
      throw createError(
        "A valid mapped user ID is required.",
        400,
        "INVALID_MAPPED_USER_ID"
      );
    }

    const { endpoint } = await getOwnedEndpoint(
      userId,
      serverId
    );

    const index = findMappingIndex(
      endpoint,
      deviceId,
      mappedUserId
    );

    if (index === -1) {
      throw createError(
        "Redirection link not found.",
        404,
        "REDIRECTION_LINK_NOT_FOUND"
      );
    }

    const updates = req.body;
    const link = endpoint.redirectionLinks[index];

    if (updates.destinationLink !== undefined) {
      link.destinationLink = validateDestinationLink(
        updates.destinationLink,
        endpoint.security.httpsOnly
      );
    }

    if (updates.priority !== undefined) {
      if (
        !Number.isInteger(updates.priority) ||
        updates.priority < 1
      ) {
        throw createError(
          "Priority must be a positive integer.",
          400,
          "INVALID_PRIORITY"
        );
      }

      link.priority = updates.priority;
    }

    if (updates.isActive !== undefined) {
      if (typeof updates.isActive !== "boolean") {
        throw createError(
          "isActive must be a boolean.",
          400,
          "INVALID_LINK_STATUS"
        );
      }

      link.isActive = updates.isActive;
    }

    updateConfigVersion(endpoint);

    await endpoint.save();

    return res.status(200).json({
      success: true,
      message: "Redirection link updated successfully.",
      data: {
        redirectionLink: endpoint.redirectionLinks[index],
        configVersion: endpoint.configVersion,
      },
    });
  } catch (error) {
    return handleEndpointError(error, next);
  }
};

// REMOVE REDIRECTION LINK
const removeRedirectionLink = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { serverId, deviceId } = req.params;
    const { userId: mappedUserId } = req.query;

    if (
      !isValidObjectId(deviceId) ||
      !isValidObjectId(mappedUserId)
    ) {
      throw createError(
        "Valid device ID and mapped user ID are required.",
        400,
        "INVALID_MAPPING_ID"
      );
    }

    const { endpoint } = await getOwnedEndpoint(
      userId,
      serverId
    );

    const index = findMappingIndex(
      endpoint,
      deviceId,
      mappedUserId
    );

    if (index === -1) {
      throw createError(
        "Redirection link not found.",
        404,
        "REDIRECTION_LINK_NOT_FOUND"
      );
    }

    endpoint.redirectionLinks.splice(index, 1);

    updateConfigVersion(endpoint);

    await endpoint.save();

    return res.status(200).json({
      success: true,
      message: "Redirection link removed successfully.",
      data: {
        redirectionLinks: endpoint.redirectionLinks,
        configVersion: endpoint.configVersion,
      },
    });
  } catch (error) {
    return handleEndpointError(error, next);
  }
};

// UPDATE ROUTING MODE
const updateRoutingMode = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { serverId } = req.params;
    const { routingMode } = req.body;

    if (!["redirect", "proxy"].includes(routingMode)) {
      throw createError(
        "Routing mode must be redirect or proxy.",
        400,
        "INVALID_ROUTING_MODE"
      );
    }

    const { endpoint } = await getOwnedEndpoint(
      userId,
      serverId
    );

    endpoint.routingMode = routingMode;

    updateConfigVersion(endpoint);

    await endpoint.save();

    return res.status(200).json({
      success: true,
      message: "Routing mode updated successfully.",
      data: {
        routingMode: endpoint.routingMode,
        configVersion: endpoint.configVersion,
      },
    });
  } catch (error) {
    return handleEndpointError(error, next);
  }
};

// UPDATE SECURITY SETTINGS
const updateEndpointSecurity = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { serverId } = req.params;

    const {
      enabled,
      httpsOnly,
      allowedMethods,
      rateLimitPerMinute,
    } = req.body;

    const { endpoint } = await getOwnedEndpoint(
      userId,
      serverId
    );

    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") {
        throw createError(
          "enabled must be a boolean.",
          400,
          "INVALID_SECURITY_SETTING"
        );
      }

      endpoint.security.enabled = enabled;
    }

    if (httpsOnly !== undefined) {
      if (typeof httpsOnly !== "boolean") {
        throw createError(
          "httpsOnly must be a boolean.",
          400,
          "INVALID_SECURITY_SETTING"
        );
      }

      endpoint.security.httpsOnly = httpsOnly;
    }

    if (allowedMethods !== undefined) {
      const validMethods = [
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ];

      if (
        !Array.isArray(allowedMethods) ||
        allowedMethods.length === 0 ||
        allowedMethods.some(
          (method) =>
            typeof method !== "string" ||
            !validMethods.includes(method.toUpperCase())
        )
      ) {
        throw createError(
          "Invalid allowed HTTP methods.",
          400,
          "INVALID_ALLOWED_METHODS"
        );
      }

      endpoint.security.allowedMethods = [
        ...new Set(
          allowedMethods.map((method) => method.toUpperCase())
        ),
      ];
    }

    if (rateLimitPerMinute !== undefined) {
      if (
        !Number.isInteger(rateLimitPerMinute) ||
        rateLimitPerMinute < 1
      ) {
        throw createError(
          "Rate limit must be a positive integer.",
          400,
          "INVALID_RATE_LIMIT"
        );
      }

      endpoint.security.rateLimitPerMinute = rateLimitPerMinute;
    }

    // Revalidate all destinations if HTTPS is required
    if (endpoint.security.httpsOnly) {
      for (const link of endpoint.redirectionLinks) {
        link.destinationLink = validateDestinationLink(
          link.destinationLink,
          true
        );
      }
    }

    updateConfigVersion(endpoint);

    await endpoint.save();

    return res.status(200).json({
      success: true,
      message: "Security settings updated successfully.",
      data: {
        security: endpoint.security,
        configVersion: endpoint.configVersion,
      },
    });
  } catch (error) {
    return handleEndpointError(error, next);
  }
};

// ACTIVATE / DEACTIVATE ENDPOINT
const updateEndpointStatus = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { serverId } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      throw createError(
        "isActive must be a boolean.",
        400,
        "INVALID_ENDPOINT_STATUS"
      );
    }

    const { endpoint } = await getOwnedEndpoint(
      userId,
      serverId
    );

    endpoint.isActive = isActive;

    updateConfigVersion(endpoint);

    await endpoint.save();

    return res.status(200).json({
      success: true,
      message: isActive
        ? "Endpoint activated successfully."
        : "Endpoint deactivated successfully.",
      data: {
        isActive: endpoint.isActive,
        configVersion: endpoint.configVersion,
      },
    });
  } catch (error) {
    return handleEndpointError(error, next);
  }
};

// DELETE SERVER ENDPOINT
const deleteServerEndpoint = async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { serverId } = req.params;

    const { endpoint } = await getOwnedEndpoint(
      userId,
      serverId
    );

    await ServerEndpoint.deleteOne({
      _id: endpoint._id,
      serverId: endpoint.serverId,
    });

    return res.status(200).json({
      success: true,
      message: "Server endpoint deleted successfully.",
      data: {
        serverId,
        permanentLink: buildPermanentLink(endpoint),
      },
    });
  } catch (error) {
    return next(error);
  }
};

// Select the destination for a request. The server's active device always
// wins; priority only orders links that have no active-device match.
const selectDestination = (endpoint, activeDeviceId) => {
  const activeLinks = endpoint.redirectionLinks
    .filter((link) => link.isActive)
    .sort((a, b) => a.priority - b.priority);

  if (activeLinks.length === 0) {
    throw createError(
      "No active destination is configured for this endpoint.",
      503,
      "NO_ACTIVE_DESTINATION"
    );
  }

  const preferred = activeDeviceId
    ? activeLinks.find((link) => String(link.deviceId) === String(activeDeviceId))
    : null;

  return (preferred || activeLinks[0]).destinationLink;
};

// Check server and monitoring health
const checkServerHealth = async (serverId) => {
  const server = await Server.findOne({
    _id: serverId,
    isActive: true,
    status: "running",
  }).select("_id status monitoringEnabled activeDeviceId");

  if (!server) {
    throw createError(
      "The hosted server is not running.",
      503,
      "SERVER_NOT_RUNNING"
    );
  }

  // Monitoring disabled: don't require heartbeat data.
  if (!server.monitoringEnabled) {
    return server;
  }

  const monitoringData = await MonitoringData.findOne({
    serverId,
  }).select("health lastHeartbeatAt");

  if (!monitoringData) {
    throw createError(
      "Monitoring data is unavailable.",
      503,
      "MONITORING_DATA_UNAVAILABLE"
    );
  }

  if (
    monitoringData.health === "down" ||
    monitoringData.health === "unknown"
  ) {
    throw createError(
      "The hosted server is not reporting healthy status.",
      503,
      "SERVER_UNHEALTHY"
    );
  }

  const maxHeartbeatAge = Number(
    process.env.SERVER_HEARTBEAT_MAX_AGE_MS || 120000
  );

  const heartbeatAge =
    Date.now() -
    new Date(monitoringData.lastHeartbeatAt).getTime();

  if (
    !Number.isFinite(heartbeatAge) ||
    heartbeatAge < -60000 ||
    heartbeatAge > maxHeartbeatAge
  ) {
    throw createError(
      "The server heartbeat is stale.",
      503,
      "SERVER_HEARTBEAT_STALE"
    );
  }

  return server;
};

// Rewrite upstream absolute redirects to the public URL
const rewriteLocationHeader = (proxyRes, destinationUrl, publicPrefix) => {
  const location = proxyRes.headers.location;

  if (!location) {
    return;
  }

  try {
    const upstreamUrl = new URL(location, destinationUrl);

    if (upstreamUrl.origin !== destinationUrl.origin) {
      return;
    }

    proxyRes.headers.location =
      `${publicPrefix}${upstreamUrl.pathname}${upstreamUrl.search}${upstreamUrl.hash}`;
  } catch {
    // Leave invalid upstream Location headers unchanged
  }
};

// Shared proxy response listener
proxy.on("proxyRes", (proxyRes, req) => {
  if (req.__spareShareDestinationUrl && req.__spareSharePublicPrefix !== undefined) {
    rewriteLocationHeader(
      proxyRes,
      req.__spareShareDestinationUrl,
      req.__spareSharePublicPrefix
    );
  }

  let bytesOut = 0;
  proxyRes.on("data", (chunk) => {bytesOut += chunk.length;});
  proxyRes.on("end", () => {req.__spareShareBytesOut = bytesOut;});
});

// Sockets are destroyed on a failed WebSocket upgrade.
proxy.on("error", (error, req, target) => {
  if (target && typeof target.destroy === "function" && !target.writeHead) {
    target.destroy();
  }
});

// Per-endpoint request limiting, driven by security.rateLimitPerMinute.
// Counters are held in memory per API instance.
const endpointLimiters = new Map();

const enforceEndpointRateLimit = (endpoint, req, res) => {
  if (!endpoint.security.enabled) return;

  const limit = endpoint.security.rateLimitPerMinute || 120;
  const key = `${endpoint._id}:${limit}`;
  let limiter = endpointLimiters.get(key);

  if (!limiter) {
    limiter = createRateLimiter({ windowMs: 60 * 1000, max: limit });
    endpointLimiters.set(key, limiter);
  }

  const result = limiter.consume(`${req.ip}`);

  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    throw createError(
      "Rate limit exceeded for this endpoint.",
      429,
      "ENDPOINT_RATE_LIMITED"
    );
  }
};

const PERMANENT_ID_PATTERN = /^[a-z0-9-]{1,120}$/;

// Wildcard-domain routing: <permanentId>.<SPARESHARE_APPS_DOMAIN>.
// Lets a hosted web app live at the root of its own origin.
const getPermanentIdFromHost = (req) => {
  const appsDomain = String(process.env.SPARESHARE_APPS_DOMAIN || "").toLowerCase();
  if (!appsDomain) return null;

  const host = String(req.headers.host || "").toLowerCase().split(":")[0];
  if (!host.endsWith(`.${appsDomain}`)) return null;

  const label = host.slice(0, -(appsDomain.length + 1));
  return PERMANENT_ID_PATTERN.test(label) ? label : null;
};

// Resolve an incoming public request to an upstream target.
const resolveProxyTarget = async (req, res, { permanentId, pathPrefix }) => {
  if (typeof permanentId !== "string" || !PERMANENT_ID_PATTERN.test(permanentId)) {
    throw createError(
      "Invalid permanent endpoint identifier.",
      400,
      "INVALID_PERMANENT_ID"
    );
  }

  const endpoint = await findEndpointByPermanentId(permanentId);

  if (!endpoint) {
    throw createError(
      "Endpoint not found or inactive.",
      404,
      "SERVER_ENDPOINT_NOT_FOUND"
    );
  }

  if (endpoint.security.enabled && !endpoint.security.allowedMethods.includes(req.method)) {
    throw createError(
      "HTTP method is not allowed.",
      405,
      "HTTP_METHOD_NOT_ALLOWED"
    );
  }

  if (res) {
    enforceEndpointRateLimit(endpoint, req, res);
  }

  const server = await checkServerHealth(endpoint.serverId);

  const destination = validateDestinationLink(
    selectDestination(endpoint, server.activeDeviceId),
    endpoint.security.httpsOnly
  );

  const destinationUrl = new URL(destination);

  // Path that follows the public prefix
  const incomingUrl = new URL(req.originalUrl || req.url, "http://internal.local");

  let remainingPath = incomingUrl.pathname.slice(pathPrefix.length);

  if (!remainingPath.startsWith("/")) {
    remainingPath = `/${remainingPath}`;
  }

  const basePath = destinationUrl.pathname.replace(/\/+$/, "");
  const forwardedPath = `${basePath}${remainingPath === "/" ? "" : remainingPath}` || "/";

  return {
    endpoint,
    destinationUrl,
    remainingPath,
    forwardedUrl: `${forwardedPath}${incomingUrl.search}`,
  };
};

const PROXY_OPTIONS = {
  changeOrigin: true,
  xfwd: true,
  secure: true,
  prependPath: false,
  proxyTimeout: 30000,
  timeout: 30000,
  cookieDomainRewrite: "",
};

const handleProxyRequest = async (req, res, next, { permanentId, pathPrefix, publicPrefix }) => {
  try {
    const target = await resolveProxyTarget(req, res, { permanentId, pathPrefix });
    const { endpoint, destinationUrl, remainingPath, forwardedUrl } = target;

    // Redirect mode sends the client straight to the device tunnel.
    if (endpoint.routingMode === "redirect") {
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(307, `${destinationUrl.origin}${forwardedUrl}`);
    }

    req.url = forwardedUrl;

    // Do not cache proxied responses
    res.setHeader("Cache-Control", "no-store");

    // Avoid exposing the upstream host in referrer metadata
    res.setHeader("Referrer-Policy", "same-origin");

    req.__spareShareDestinationUrl = destinationUrl;
    req.__spareSharePublicPrefix = publicPrefix;

    const requestStartedAt = Date.now();
    const bytesIn = Number(req.headers["content-length"] || 0);
    const isMonitorProbe = req.headers["user-agent"] === "SpareShare-Monitor/1.0";

    res.once("finish", () => {
      // Health probes are not customer traffic.
      if (isMonitorProbe) return;

      recordProxyTraffic({
        serverId: endpoint.serverId,
        method: req.method,
        path: remainingPath || "/",
        statusCode: res.statusCode,
        durationMs: Date.now() - requestStartedAt,
        bytesIn,
        bytesOut: req.__spareShareBytesOut || 0,
      });
    });

    return proxy.web(
      req,
      res,
      { ...PROXY_OPTIONS, target: destinationUrl.origin },
      (error) => {
        if (res.headersSent) {
          return res.destroy(error);
        }

        return next(
          createError(
            "The destination server could not be reached.",
            502,
            "UPSTREAM_SERVER_ERROR"
          )
        );
      }
    );
  } catch (error) {
    return next(error);
  }
};

// PUBLIC REVERSE PROXY HANDLER: <base>/s/:permanentId/...
const proxyTraffic = (req, res, next) => {
  const { permanentId } = req.params;
  const pathPrefix = `/s/${permanentId}`;

  let publicPrefix = pathPrefix;
  try {
    publicPrefix = `${new URL(getPublicBaseUrl()).origin}${pathPrefix}`;
  } catch {
    // Fall back to a relative prefix.
  }

  return handleProxyRequest(req, res, next, { permanentId, pathPrefix, publicPrefix });
};

// PUBLIC REVERSE PROXY HANDLER: <permanentId>.<apps domain>/...
const proxyByHost = (req, res, next) => {
  const permanentId = getPermanentIdFromHost(req);

  if (!permanentId) {
    return next();
  }

  return handleProxyRequest(req, res, next, { permanentId, pathPrefix: "", publicPrefix: "" });
};

// WebSocket upgrades for both routing styles. Attached to the HTTP
// server's "upgrade" event.
const proxyUpgrade = async (req, socket, head) => {
  const reject = (statusCode, message) => {
    socket.write(
      `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    );
    socket.destroy();
  };

  try {
    req.originalUrl = req.url;
    req.ip = req.socket.remoteAddress;

    let permanentId = getPermanentIdFromHost(req);
    let pathPrefix = "";

    if (!permanentId) {
      const match = /^\/s\/([a-z0-9-]{1,120})(?=\/|\?|$)/.exec(req.url);
      if (!match) return reject(404, "Not Found");
      permanentId = match[1];
      pathPrefix = `/s/${permanentId}`;
    }

    const { destinationUrl, forwardedUrl, endpoint } = await resolveProxyTarget(req, null, {
      permanentId,
      pathPrefix,
    });

    if (endpoint.routingMode !== "proxy") {
      return reject(400, "Bad Request");
    }

    req.url = forwardedUrl;

    return proxy.ws(req, socket, head, { ...PROXY_OPTIONS, target: destinationUrl.origin });
  } catch (error) {
    return reject(error.statusCode || 502, "Upstream Unavailable");
  }
};

module.exports = {
  createServerEndpoint,
  getServerEndpoint,
  getServerEndpoints,
  addRedirectionLink,
  updateRedirectionLink,
  removeRedirectionLink,
  updateRoutingMode,
  updateEndpointSecurity,
  updateEndpointStatus,
  deleteServerEndpoint,
  proxyTraffic,
  proxyByHost,
  proxyUpgrade,
  validateDestinationLink,
};
