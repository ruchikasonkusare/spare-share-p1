const express = require("express");

const router = express.Router();

const authenticator = require("../middlewares/authenticator.middleware");
const agentAuthentication = require("../middlewares/agentAuth.middleware");
const { createRateLimiter } = require("../middlewares/rateLimit.middleware");
const controller = require("../controllers/deviceAgent.controller");

// USER-AUTHENTICATED ENDPOINTS

// Generate or rotate a device-agent credential.
router.post("/provision/:deviceId", authenticator(), controller.provisionDeviceAgent);

// Queue a command for an assigned device.
router.post("/commands", authenticator(), controller.queueCommand);

// DEVICE-AGENT-AUTHENTICATED ENDPOINTS

router.use(agentAuthentication);

// One misbehaving agent must not be able to saturate the API.
router.use(
  createRateLimiter({
    windowMs: 60 * 1000,
    max: Number(process.env.AGENT_RATE_MAX_PER_MINUTE) || 600,
    keyGenerator: (req) => `agent:${req.agent.device._id}`,
    code: "AGENT_RATE_LIMITED",
  })
);

router.post("/heartbeat", controller.heartbeat);
router.get("/config", controller.getConfiguration);
router.get("/commands", controller.pollCommands);
router.post("/commands/:commandId/result", controller.commandResult);

router.post("/servers/:serverId/tunnel", controller.updateTunnel);
router.get("/servers/:serverId/environment", controller.getServerEnvironment);
router.post("/servers/:serverId/logs", controller.pushLogs);

router.get("/deployments/:deploymentId", controller.getDeploymentSpec);
router.post("/deployments/:deploymentId/progress", controller.deploymentProgress);

router.post("/backups/:backupId/upload-target", controller.backupUploadTarget);
router.put("/backups/:backupId/content", controller.backupUploadContent);
router.post("/backups/:backupId/complete", controller.backupComplete);
router.post("/backups/:backupId/fail", controller.backupFail);
router.get("/backups/:backupId/download-source", controller.backupDownloadSource);
router.get("/backups/:backupId/content", controller.backupDownloadContent);

router.get("/runtimes/:name", controller.getRuntimeArchive);
router.get("/bundle/meta", controller.getBundleMeta);
router.get("/bundle", controller.getBundle);

module.exports = router;
