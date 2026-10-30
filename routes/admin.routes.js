const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const staffController = require("../controllers/admin/staff.controller");
const passwordResetController = require("../controllers/admin/password-reset.controller");
const orderController = require("../controllers/admin/order.controller");
const productController = require("../controllers/admin/product.controller");
const returnOrderController = require("../controllers/admin/return-order.controller");

// Manager và Staff xem danh sách và chi tiết sản phẩm
router.get(
  "/products",
  authMiddleware,
  authMiddleware.requireRole("Manager", "Staff"),
  productController.getProducts
);
router.post(
  "/products",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  productController.createProduct
);
router.post(
  "/products/bulk-import",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  productController.bulkImportProducts
);
router.get(
  "/products/:id",
  authMiddleware,
  authMiddleware.requireRole("Manager", "Staff"),
  productController.getProductById
);
router.put(
  "/products/:id",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  productController.updateProduct
);
router.delete(
  "/products/:id",
  authMiddleware,
  authMiddleware.requireRole("Manager"),
  productController.deleteProduct
);
router.get(
  "/categories",
  authMiddleware,
  authMiddleware.requireRole("Manager", "Staff"),
  productController.getCategories
);
router.get(
  "/brands",
  authMiddleware,
  authMiddleware.requireRole("Manager", "Staff"),
  productController.getBrands
);

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


// ==========================================
// HẬU MÃI & ĐỔI TRẢ (H.Ngọc)
// Staff thao tác xử lý, Manager chỉ xem
// ==========================================
router.get(
  "/returns",
  authMiddleware,
  authMiddleware.requireRole("Staff", "Manager"),
  returnOrderController.getReturns
);

router.get(
  "/returns/:id",
  authMiddleware,
  authMiddleware.requireRole("Staff", "Manager"),
  returnOrderController.getReturnDetail
);

router.post(
  "/returns/:id/approve",
  authMiddleware,
  authMiddleware.requireRole("Staff"),
  returnOrderController.approveReturn
);

router.post(
  "/returns/:id/reject",
  authMiddleware,
  authMiddleware.requireRole("Staff"),
  returnOrderController.rejectReturn
);

router.post(
  "/returns/:id/accept-goods",
  authMiddleware,
  authMiddleware.requireRole("Staff"),
  returnOrderController.acceptGoods
);

router.post(
  "/returns/:id/reject-goods",
  authMiddleware,
  authMiddleware.requireRole("Staff"),
  returnOrderController.rejectGoods
);

module.exports = router;
