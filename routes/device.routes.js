const express = require("express");

const router = express.Router();

const authenticator = require("../middlewares/authenticator.middleware");
const controller = require("../controllers/device.controller");

router.use(authenticator());

router.get("/", controller.listDevices);
router.post("/", controller.registerDevice);
router.get("/:deviceId", controller.getDevice);
router.patch("/:deviceId", controller.updateDevice);
router.delete("/:deviceId", controller.removeDevice);

// Device-agent credential lifecycle
router.post("/:deviceId/agent-token", controller.provisionAgent);
router.delete("/:deviceId/agent-token", controller.revokeAgent);

module.exports = router;
