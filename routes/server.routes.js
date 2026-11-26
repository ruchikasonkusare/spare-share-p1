const express = require("express");
const router = express.Router();

const {
  createServer,
  getServers,
  getServerById,
  updateServer,
  deleteServer,
  checkSlugAvailability,
  updateServerMonitoring,
  updateServerMetrics,
} = require("../controllers/server.controller");

const ops = require("../controllers/serverOps.controller");
const authenticator = require("../middlewares/authenticator.middleware");

router.use(authenticator());

// Static paths must be registered before "/:serverId".
router.get("/check-slug", checkSlugAvailability);

// Server CRUD routes
router.post("/", createServer);
router.get("/", getServers);
router.get("/:serverId", getServerById);
router.put("/:serverId", updateServer);
router.delete("/:serverId", deleteServer);
router.patch("/:serverId/monitoring", updateServerMonitoring);
router.patch("/:serverId/metrics", updateServerMetrics);

// Live overview: permanent URL, runtime state, metrics, devices
router.get("/:serverId/overview", ops.getServerOverview);

// Multi-device hosting
router.get("/:serverId/devices", ops.listServerDevices);
router.post("/:serverId/devices", ops.assignDevice);
router.delete("/:serverId/devices/:deviceId", ops.unassignDevice);

// Process control and logs
router.post("/:serverId/actions", ops.serverAction);
router.get("/:serverId/logs", ops.getServerLogs);

// Deployments
router.post("/:serverId/deployments", ops.createDeployment);
router.get("/:serverId/deployments", ops.listDeployments);
router.get("/:serverId/deployments/:deploymentId", ops.getDeployment);
router.post("/:serverId/deployments/:deploymentId/cancel", ops.cancelDeployment);
router.post("/:serverId/deployments/:deploymentId/rollback", ops.rollbackDeployment);

// Backup and restore
router.get("/:serverId/backups", ops.listBackups);
router.post("/:serverId/backups", ops.createBackup);
router.patch("/:serverId/backups/settings", ops.updateBackupSettings);
router.delete("/:serverId/backups/:backupId", ops.deleteBackup);
router.post("/:serverId/backups/:backupId/restore", ops.restoreBackup);

// Failover
router.get("/:serverId/failover", ops.listFailoverEvents);
router.post("/:serverId/failover", ops.triggerFailover);
router.patch("/:serverId/failover/settings", ops.updateFailoverSettings);

module.exports = router;
