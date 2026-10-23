const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const { requireOrderOwner, requireSelf } = require("../middleware/order-owner.middleware");
const orderHistoryController = require("../controllers/order-history.controller");

// Khách chỉ được xem và thao tác trên đơn của chính mình
router.get(
  "/:userId",
  authMiddleware,
  requireSelf((req) => req.params.userId),
  orderHistoryController.getOrderHistory
);
router.patch(
  "/:orderId/received",
  authMiddleware,
  requireOrderOwner((req) => req.params.orderId),
  orderHistoryController.markOrderReceived
);
router.patch(
  "/:orderId/cancel",
  authMiddleware,
  requireOrderOwner((req) => req.params.orderId),
  orderHistoryController.cancelOrder
);
router.put(
  "/mark-reviewed",
  authMiddleware,
  requireOrderOwner((req) => req.body?.orderId || req.body?.Order_id || req.body?.Order_code),
  orderHistoryController.markOrderReviewed
);

module.exports = router;
