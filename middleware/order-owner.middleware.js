const { Order, Payment } = require("../models/schema");

function cleanText(value) {
  return String(value || "").trim();
}

function forbidden(res) {
  return res.status(403).json({
    success: false,
    message: "Bạn không có quyền thao tác trên đơn hàng này",
  });
}

// Chỉ chủ đơn hàng mới được thao tác. Dùng sau authMiddleware.
// Không tìm thấy mã đơn / đơn hàng thì để controller tự trả lỗi 400/404 như cũ.
function requireOrderOwner(getOrderId) {
  return async (req, res, next) => {
    try {
      const orderId = cleanText(getOrderId(req));
      if (!orderId) return next();

      const order = await Order.findOne({ Order_id: orderId }).select("User_id").lean();
      if (!order) return next();

      if (order.User_id !== req.user?.User_id) {
        return forbidden(res);
      }

      return next();
    } catch (error) {
      console.error("Lỗi kiểm tra chủ đơn hàng:", error);
      return res.status(500).json({ success: false, message: "Lỗi xác thực đơn hàng" });
    }
  };
}

// Giống requireOrderOwner nhưng tra đơn hàng từ mã thanh toán
function requirePaymentOwner(getPaymentId) {
  return async (req, res, next) => {
    try {
      const paymentId = cleanText(getPaymentId(req));
      if (!paymentId) return next();

      const payment = await Payment.findOne({ Payment_id: paymentId }).select("Order_id").lean();
      if (!payment) return next();

      return requireOrderOwner(() => payment.Order_id)(req, res, next);
    } catch (error) {
      console.error("Lỗi kiểm tra chủ thanh toán:", error);
      return res.status(500).json({ success: false, message: "Lỗi xác thực thanh toán" });
    }
  };
}

// Người dùng chỉ được xem dữ liệu của chính mình (route có :userId)
function requireSelf(getUserId) {
  return (req, res, next) => {
    if (cleanText(getUserId(req)) !== req.user?.User_id) {
      return res.status(403).json({
        success: false,
        message: "Bạn không có quyền xem dữ liệu của tài khoản khác",
      });
    }
    return next();
  };
}

module.exports = {
  requireOrderOwner,
  requirePaymentOwner,
  requireSelf,
};
