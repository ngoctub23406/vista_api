const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const { requirePaymentOwner } = require("../middleware/order-owner.middleware");
const paymentController = require("../controllers/payment.controller");

router.get(
  "/:paymentId/status",
  authMiddleware,
  requirePaymentOwner((req) => req.params.paymentId),
  paymentController.getPaymentStatus
);
router.post(
  "/:paymentId/confirm",
  authMiddleware,
  requirePaymentOwner((req) => req.params.paymentId),
  paymentController.confirmBankTransfer
);

module.exports = router;
