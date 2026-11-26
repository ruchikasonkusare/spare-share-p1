const express = require("express");

const router = express.Router();

const authenticator = require("../middlewares/authenticator.middleware");
const controller = require("../controllers/notification.controller");

router.use(authenticator());

router.get("/", controller.listNotifications);
router.get("/unread-count", controller.getUnreadCount);
router.post("/read-all", controller.markAllRead);
router.post("/:notificationId/read", controller.markRead);
router.delete("/:notificationId", controller.deleteNotification);

module.exports = router;
