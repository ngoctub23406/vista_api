const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const staffController = require("../controllers/admin/staff.controller");
const passwordResetController = require("../controllers/admin/password-reset.controller");

// Chỉ Manager được xem danh sách Staff
router.get(
  "/staff",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  staffController.getStaffList
);

// Khôi phục mật khẩu Admin: Manager và Staff
router.post("/auth/forgot-password", passwordResetController.forgotPassword);
router.post("/auth/verify-otp", passwordResetController.verifyOtp);
router.post("/auth/reset-password", passwordResetController.resetPassword);

module.exports = router;
