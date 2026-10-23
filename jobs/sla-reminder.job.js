const { Order } = require("../models/schema");
const { buildSlaStages, SLA_STAGES } = require("../services/order-sla.service");
const { notifyOrderEvent } = require("../services/notification.service");

const SCAN_INTERVAL_MS = 60 * 1000;
// Chỉ nhắc các đơn vừa quá hạn trong 24 giờ gần đây, tránh dồn hàng loạt thông báo cho dữ liệu cũ
const REMIND_WINDOW_MS = 24 * 60 * 60 * 1000;

const EVENT_BY_STAGE = {
  [SLA_STAGES.CONFIRM]: "sla_confirm_overdue",
  [SLA_STAGES.HAND_OVER]: "sla_hand_over_overdue",
};

let timer = null;
let isRunning = false;

async function runOnce() {
  if (isRunning) return;
  isRunning = true;

  try {
    const now = new Date();
    const overdueOrders = await Order.aggregate([
      { $match: { Status: "processing" } },
      {
        $lookup: {
          from: "Payment",
          localField: "Order_id",
          foreignField: "Order_id",
          as: "PaymentInfo",
        },
      },
      { $unwind: { path: "$PaymentInfo", preserveNullAndEmptyArrays: true } },
      {
        $match: {
          $or: [
            { "PaymentInfo.Payment_type": { $ne: "BankTransfer" } },
            { "PaymentInfo.Payment_status": "paid" },
          ],
        },
      },
      ...buildSlaStages(now),
      {
        $match: {
          Is_overdue: true,
          Sla_deadline: { $gte: new Date(now.getTime() - REMIND_WINDOW_MS) },
          $expr: { $not: { $in: ["$Sla_stage", { $ifNull: ["$Sla_reminded", []] }] } },
        },
      },
      { $project: { Order_id: 1, Sla_stage: 1 } },
    ]);

    for (const order of overdueOrders) {
      // Đánh dấu trước để không nhắc trùng khi có nhiều lần quét chồng nhau
      const result = await Order.updateOne(
        { Order_id: order.Order_id, Sla_reminded: { $ne: order.Sla_stage } },
        { $addToSet: { Sla_reminded: order.Sla_stage } }
      );

      if (result.modifiedCount > 0) {
        notifyOrderEvent(order.Order_id, EVENT_BY_STAGE[order.Sla_stage]);
      }
    }
  } catch (error) {
    console.error("Lỗi quét đơn quá hạn xử lý:", error);
  } finally {
    isRunning = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(runOnce, SCAN_INTERVAL_MS);
  console.log("SLA reminder started");
}

module.exports = { start, runOnce };
