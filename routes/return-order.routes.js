const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const { requireOrderOwner } = require("../middleware/order-owner.middleware");
const {
  createReturnOrder,
  getReturnOrderByOrderId,
} = require("../controllers/return-order.controller");

router.post(
  "/",
  authMiddleware,
  requireOrderOwner((req) => req.body?.Order_id || req.body?.orderId),
  createReturnOrder
);
router.get(
  "/:orderId",
  authMiddleware,
  requireOrderOwner((req) => req.params.orderId),
  getReturnOrderByOrderId
);

module.exports = router;
