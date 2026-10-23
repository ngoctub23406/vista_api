const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const orderController = require("../controllers/order.controller");

// Người đặt đơn lấy từ token, không tin User_id gửi lên
router.post(
  "/",
  authMiddleware,
  (req, res, next) => {
    if (req.body?.order) {
      req.body.order.User_id = req.user.User_id;
    }
    next();
  },
  orderController.createOrder
);

module.exports = router;
