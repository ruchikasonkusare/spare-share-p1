const express = require("express");
const {downloadRootfs, saveDeviceInfo, downloadPip, downloadNpm, downloadJdk, downloadPython} = require("../controllers/installation.controller");
const router = express.Router();
const authenticator = require("../middlewares/authenticator.middleware");

// Debian ARM64 Rootfs intallation
router.get("/getDebian", downloadRootfs);
router.post("/saveInfo", authenticator(), saveDeviceInfo);

// Runtime and Package Downloads
router.get("/getPip", downloadPip);
router.get("/getNpm", downloadNpm);
router.get("/getJdk", downloadJdk);
router.get("/getPython", downloadPython);

module.exports = router;
