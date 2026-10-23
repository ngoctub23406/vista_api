const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const notificationController = require("../controllers/notification.controller");

router.get("/", authMiddleware, notificationController.getNotifications);
router.patch("/read-all", authMiddleware, notificationController.markAllAsRead);
router.patch("/:id/read", authMiddleware, notificationController.markAsRead);

module.exports = router;
