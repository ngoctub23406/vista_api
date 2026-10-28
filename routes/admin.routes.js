const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const staffController = require("../controllers/admin/staff.controller");
const passwordResetController = require("../controllers/admin/password-reset.controller");
const orderController = require("../controllers/admin/order.controller");

// Quản lý nhân sự: chỉ Manager
router.get(
  "/staff",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  staffController.getStaffList
);
router.post(
  "/staff",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  staffController.createStaff
);
// Phải đặt trước "/staff/:userId" để "availability" không bị coi là mã nhân viên
router.get(
  "/staff/availability",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  staffController.checkAvailability
);
router.get(
  "/staff/:userId",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  staffController.getStaffDetail
);
router.patch(
  "/staff/:userId",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  staffController.updateStaff
);
router.patch(
  "/staff/:userId/lock",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  staffController.lockStaff
);
router.patch(
  "/staff/:userId/unlock",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  staffController.unlockStaff
);

// Khôi phục mật khẩu Admin: Manager và Staff
router.post("/auth/forgot-password", passwordResetController.forgotPassword);
router.post("/auth/verify-otp", passwordResetController.verifyOtp);
router.post("/auth/reset-password", passwordResetController.resetPassword);
router.post(
  "/auth/change-password",
  authMiddleware,
  authMiddleware.requireRole("Manager", "Staff"),
  passwordResetController.changePassword
);

// Xử lý đơn hàng: Staff thao tác, Manager chỉ xem
router.get(
  "/orders/cancel-reasons",
  authMiddleware,
  authMiddleware.requireRole("Staff", "Manager"),
  orderController.getCancelReasons
);
router.post(
  "/orders/bulk",
  authMiddleware,
  authMiddleware.requireRole("Staff"),
  orderController.bulkUpdate
);
router.post(
  "/orders/labels",
  authMiddleware,
  authMiddleware.requireRole("Staff"),
  orderController.getLabels
);
router.get(
  "/orders",
  authMiddleware,
  authMiddleware.requireRole("Staff", "Manager"),
  orderController.getOrders
);
router.get(
  "/orders/:orderId",
  authMiddleware,
  authMiddleware.requireRole("Staff", "Manager"),
  orderController.getOrderDetail
);
router.patch(
  "/orders/:orderId/confirm",
  authMiddleware,
  authMiddleware.requireRole("Staff"),
  orderController.confirmOrder
);
router.patch(
  "/orders/:orderId/cancel",
  authMiddleware,
  authMiddleware.requireRole("Staff"),
  orderController.cancelOrder
);
router.patch(
  "/orders/:orderId/hand-over",
  authMiddleware,
  authMiddleware.requireRole("Staff"),
  orderController.handOverOrder
);

module.exports = router;
