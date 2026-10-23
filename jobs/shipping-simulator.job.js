const { Order, Delivery, Payment } = require("../models/schema");
const {
  ORDER_EVENTS,
  SYSTEM_ACTOR,
  buildHistoryEntry,
  tryCompleteOrder,
} = require("../services/order-status.service");
const { notifyOrderEvent } = require("../services/notification.service");
const { requestTrackingNumber, assignTrackingNumber } = require("../services/tracking.service");

// Cấu hình thời gian giả lập đơn vị vận chuyển (đổi ở đây khi demo)
const DELIVERY_DELAY_MS = 45 * 1000; // Sau bàn giao (đơn đang giao) → ĐVVC đã giao
const AUTO_RECEIVE_DELAY_MS = 45 * 1000; // Sau khi giao → tự xác nhận thay khách
const SCAN_INTERVAL_MS = 15 * 1000;

let timer = null;
let isRunning = false;

function eventBefore(event, cutoff) {
  return { Status_history: { $elemMatch: { Event: event, Created_at: { $lte: cutoff } } } };
}

// Đơn cũ: đã bàn giao nhưng còn ở "Đang xử lý" (logic cũ chờ ĐVVC lấy hàng)
// → chuyển ngay sang "Đang giao". Đơn mới bàn giao là sang "Đang giao" luôn.
async function migrateHandedOverOrders() {
  const orders = await Order.find({
    Status: "processing",
    "Status_history.Event": ORDER_EVENTS.HANDED_OVER,
  }).select("Order_id").lean();

  for (const order of orders) {
    const result = await Order.updateOne(
      { Order_id: order.Order_id, Status: "processing" },
      { $set: { Status: "shipping" } }
    );

    if (result.modifiedCount > 0) {
      await Delivery.updateOne({ Order_id: order.Order_id }, { $set: { Status: "shipping" } });
      notifyOrderEvent(order.Order_id, "order_handed_over");
    }
  }
}

// Bàn giao đủ thời gian → ĐVVC báo đã giao (đơn cũ không có mốc bàn giao cũng được giao luôn)
async function simulateDelivery(now) {
  const cutoff = new Date(now - DELIVERY_DELAY_MS);
  const orders = await Order.find({
    Status: "shipping",
    $and: [
      { "Status_history.Event": { $ne: ORDER_EVENTS.CARRIER_DELIVERED } },
      {
        $or: [
          eventBefore(ORDER_EVENTS.HANDED_OVER, cutoff),
          { "Status_history.Event": { $ne: ORDER_EVENTS.HANDED_OVER } },
        ],
      },
    ],
  }).select("Order_id").lean();

  for (const order of orders) {
    const result = await Order.updateOne(
      {
        Order_id: order.Order_id,
        Status: "shipping",
        "Status_history.Event": { $ne: ORDER_EVENTS.CARRIER_DELIVERED },
      },
      {
        $push: {
          Status_history: buildHistoryEntry({
            fromStatus: "shipping",
            toStatus: "shipping",
            event: ORDER_EVENTS.CARRIER_DELIVERED,
            actor: SYSTEM_ACTOR,
          }),
        },
      }
    );

    if (result.modifiedCount === 0) {
      continue;
    }

    await Delivery.updateOne(
      { Order_id: order.Order_id },
      { $set: { Status: "delivered", Delivered_at: new Date(now) } }
    );

    // ĐVVC đã thu tiền hộ với đơn COD
    await Payment.updateOne(
      { Order_id: order.Order_id, Payment_type: "COD", Payment_status: { $ne: "paid" } },
      { $set: { Payment_status: "paid", Paid_at: new Date(now) } }
    );

    // Nếu khách đã xác nhận trước đó thì đơn hoàn tất luôn (đã có thông báo hoàn tất)
    const completed = await tryCompleteOrder(order.Order_id);
    if (!completed) {
      notifyOrderEvent(order.Order_id, "order_delivered");
    }
  }
}

// Khách chưa bấm "Đã nhận hàng" sau thời gian chờ → hệ thống tự xác nhận
async function simulateAutoReceive(now) {
  const cutoff = new Date(now - AUTO_RECEIVE_DELAY_MS);
  const orders = await Order.find({
    Status: "shipping",
    ...eventBefore(ORDER_EVENTS.CARRIER_DELIVERED, cutoff),
    "Status_history.Event": {
      $nin: [ORDER_EVENTS.CUSTOMER_RECEIVED, ORDER_EVENTS.AUTO_RECEIVED],
    },
  }).select("Order_id").lean();

  for (const order of orders) {
    const result = await Order.updateOne(
      {
        Order_id: order.Order_id,
        Status: "shipping",
        "Status_history.Event": {
          $nin: [ORDER_EVENTS.CUSTOMER_RECEIVED, ORDER_EVENTS.AUTO_RECEIVED],
        },
      },
      {
        $push: {
          Status_history: buildHistoryEntry({
            fromStatus: "shipping",
            toStatus: "shipping",
            event: ORDER_EVENTS.AUTO_RECEIVED,
            actor: SYSTEM_ACTOR,
            note: "Khách chưa xác nhận trong thời gian chờ",
          }),
        },
      }
    );

    if (result.modifiedCount > 0) {
      await tryCompleteOrder(order.Order_id);
    }
  }
}

// Sửa các đơn bị kẹt: lịch sử đã có "ĐVVC đã giao" nhưng Delivery bị ghi đè về "shipping"
// (lỗi cũ ở API lịch sử đơn hàng). Đưa Delivery về "delivered" rồi thử hoàn tất đơn.
async function repairDeliveredOrders(now) {
  const orders = await Order.find({
    Status: "shipping",
    "Status_history.Event": ORDER_EVENTS.CARRIER_DELIVERED,
  }).select("Order_id").lean();

  for (const order of orders) {
    const result = await Delivery.updateOne(
      { Order_id: order.Order_id, Status: { $ne: "delivered" } },
      { $set: { Status: "delivered", Delivered_at: new Date(now) } }
    );

    if (result.modifiedCount > 0) {
      await tryCompleteOrder(order.Order_id);
      notifyOrderEvent(order.Order_id, "delivery_repaired");
    }
  }
}

// Đơn cũ đã xác nhận trước khi có mã vận đơn tự động → cấp mã bù để in nhãn được
async function backfillTrackingNumbers() {
  const orders = await Order.find({
    Status: { $in: ["processing", "shipping"] },
    "Status_history.Event": { $all: [ORDER_EVENTS.CONFIRMED], $ne: ORDER_EVENTS.SHIPMENT_CREATED },
  }).select("Order_id Status").lean();

  for (const order of orders) {
    const trackingNumber = requestTrackingNumber();
    const result = await Order.updateOne(
      { Order_id: order.Order_id, "Status_history.Event": { $ne: ORDER_EVENTS.SHIPMENT_CREATED } },
      {
        $push: {
          Status_history: buildHistoryEntry({
            fromStatus: order.Status,
            toStatus: order.Status,
            event: ORDER_EVENTS.SHIPMENT_CREATED,
            actor: SYSTEM_ACTOR,
            note: `Mã vận đơn: ${trackingNumber} (cấp bù cho đơn cũ)`,
          }),
        },
      }
    );

    if (result.modifiedCount > 0) {
      await assignTrackingNumber(order.Order_id, trackingNumber);
      notifyOrderEvent(order.Order_id, "tracking_backfilled");
    }
  }
}

async function runOnce() {
  if (isRunning) {
    return;
  }

  isRunning = true;
  try {
    const now = Date.now();
    await backfillTrackingNumbers();
    await migrateHandedOverOrders(now);
    await simulateDelivery(now);
    await simulateAutoReceive(now);
    await repairDeliveredOrders(now);
  } catch (error) {
    console.error("Lỗi giả lập đơn vị vận chuyển:", error);
  } finally {
    isRunning = false;
  }
}

function start() {
  if (timer) {
    return;
  }

  timer = setInterval(runOnce, SCAN_INTERVAL_MS);
  console.log("Shipping simulator started");
}

module.exports = { start, runOnce };
