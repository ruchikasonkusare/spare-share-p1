const { createError } = require("../utils/errors");
const { authenticateAgentToken } = require("../services/hosting.service");

// Device-agent authentication. Attaches req.agent = { device, credential }.
const agentAuthentication = async (req, res, next) => {
  try {
    const authorization = req.headers.authorization || "";
    if (!authorization.startsWith("Bearer ")) {
      throw createError("Device-agent Bearer token is required.", 401, "AGENT_TOKEN_REQUIRED");
    }
    req.agent = await authenticateAgentToken(authorization.slice(7).trim());
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = agentAuthentication;
