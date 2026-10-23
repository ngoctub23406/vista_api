const { Order, Payment } = require("../models/schema");
const { notifyOrderEvent } = require("../services/notification.service");

function cleanString(value) {
  return String(value || "").trim();
}

exports.getPaymentStatus = async (req, res) => {
  try {
    const paymentId = cleanString(req.params.paymentId);

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mã thanh toán.",
      });
    }

    const payment = await Payment.findOne({ Payment_id: paymentId }).lean();

    return res.json({
      success: true,
      data: {
        paymentStatus: payment?.Payment_status || "pending",
        amount: Number(payment?.Amount) || 0,
        transactionCode: payment?.Transaction_code || "",
        paidAt: payment?.Paid_at || null,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.confirmBankTransfer = async (req, res) => {
  try {
    const paymentId = cleanString(req.params.paymentId || req.body.paymentId);
    const amount = Math.round(Number(req.body.amount) || 0);
    const transferContent = cleanString(req.body.transferContent);

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mã thanh toán.",
      });
    }

    const payment = await Payment.findOne({ Payment_id: paymentId });
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy giao dịch thanh toán.",
      });
    }

    const order = await Order.findOne({ Order_id: payment.Order_id }).lean();
    const orderStatus = String(order?.Status || "").trim().toLowerCase();
    const shouldStartProcessingTimer = orderStatus === "pending_payment" || !order?.Processing_started_at;

    if (payment.Payment_type !== "BankTransfer") {
      return res.status(400).json({
        success: false,
        message: "Giao dịch này không phải thanh toán chuyển khoản.",
      });
    }

    if (payment.Payment_status === "paid") {
      if (shouldStartProcessingTimer) {
        await Order.updateOne(
          { Order_id: payment.Order_id },
          {
            $set: {
              Status: "processing",
              Processing_started_at: new Date(),
            },
          }
        );
      }

      return res.json({
        success: true,
        message: "Giao dịch đã được thanh toán.",
        data: {
          paymentStatus: "paid",
          transactionCode: payment.Transaction_code,
        },
      });
    }

    if (payment.Payment_status === "failed") {
      return res.status(400).json({
        success: false,
        message: payment.Failure_reason || "Giao dịch đã thất bại.",
      });
    }

    const expectedAmount = Math.round(Number(payment.Amount) || 0);
    if (expectedAmount > 0 && amount !== expectedAmount) {
      return res.status(400).json({
        success: false,
        message: "Số tiền thanh toán không khớp với giá trị đơn hàng.",
      });
    }

    if (transferContent && transferContent !== payment.Payment_id) {
      return res.status(400).json({
        success: false,
        message: "Nội dung chuyển khoản không khớp mã đơn hàng.",
      });
    }

    payment.Payment_status = "paid";
    payment.Transaction_code = cleanString(req.body.transactionCode) || `BANK_${Date.now()}`;
    payment.Paid_at = new Date();
    payment.Failure_reason = "";
    await payment.save();

    if (shouldStartProcessingTimer) {
      await Order.updateOne(
        { Order_id: payment.Order_id },
        {
          $set: {
            Status: "processing",
            Processing_started_at: new Date(),
          },
        }
      );
    }

    notifyOrderEvent(payment.Order_id, "payment_confirmed");

    return res.json({
      success: true,
      message: "Thanh toán thành công.",
      data: {
        paymentStatus: "paid",
        transactionCode: payment.Transaction_code,
        paidAt: payment.Paid_at,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
