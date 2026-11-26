const express = require("express");
const router = express.Router();

const authenticator = require("../middlewares/authenticator.middleware");
const {
startGitHubInstallation,
completeGitHubInstallation,
completeGitHubSignIn,
handleGitHubWebhook,
getGitHubConnectionStatus,
getGitHubRepositories,
disconnectGitHub,
} = require("../controllers/github.controller");

router.post("/install", authenticator(), startGitHubInstallation);
router.get("/setup", completeGitHubInstallation);
router.get("/callback", completeGitHubSignIn);
router.post("/webhook", handleGitHubWebhook);
router.get("/status", authenticator(), getGitHubConnectionStatus);
router.get("/repositories", authenticator(), getGitHubRepositories);
router.delete("/disconnect", authenticator(), disconnectGitHub);

module.exports = router;
