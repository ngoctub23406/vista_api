const { Order, Delivery, User } = require("../models/schema");
const { notifyOrderEvent } = require("./notification.service");

// Các sự kiện được ghi vào Order.Status_history
const ORDER_EVENTS = {
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  SHIPMENT_CREATED: "shipment_created",
  HANDED_OVER: "handed_over",
  PICKED_UP: "picked_up",
  CARRIER_DELIVERED: "carrier_delivered",
  CUSTOMER_RECEIVED: "customer_received",
  AUTO_RECEIVED: "auto_received",
  COMPLETED: "completed",
  RETURN_REQUESTED: "return_requested",
};

// Người thực hiện khi trạng thái do giả lập đơn vị vận chuyển cập nhật
const SYSTEM_ACTOR = {
  id: "system",
  name: "Hệ thống – ĐVVC giả lập",
};

function buildHistoryEntry({ fromStatus, toStatus, event, actor, note }) {
  return {
    From_status: fromStatus || "",
    To_status: toStatus || "",
    Event: event,
    Actor_id: actor?.id || "",
    Actor_name: actor?.name || "",
    Note: String(note || "").trim(),
    Created_at: new Date(),
  };
}

function hasHistoryEvent(order, event) {
  const history = Array.isArray(order?.Status_history) ? order.Status_history : [];
  return history.some((item) => item.Event === event);
}

// Đơn đã được Staff xác nhận khi lịch sử có sự kiện "confirmed"
function isOrderConfirmed(order) {
  return hasHistoryEvent(order, ORDER_EVENTS.CONFIRMED);
}

function hasCustomerConfirmation(order) {
  return hasHistoryEvent(order, ORDER_EVENTS.CUSTOMER_RECEIVED) ||
    hasHistoryEvent(order, ORDER_EVENTS.AUTO_RECEIVED);
}

// Hoàn tất đơn khi đủ 2 điều kiện: ĐVVC đã giao và khách đã xác nhận nhận hàng
async function tryCompleteOrder(orderId) {
  const order = await Order.findOne({ Order_id: orderId }).lean();
  if (!order || order.Status !== "shipping" || !hasCustomerConfirmation(order)) {
    return false;
  }

  const delivery = await Delivery.findOne({ Order_id: orderId }).lean();
  if (delivery?.Status !== "delivered") {
    return false;
  }

  const result = await Order.updateOne(
    { Order_id: orderId, Status: "shipping" },
    {
      $set: { Status: "delivered" },
      $push: {
        Status_history: buildHistoryEntry({
          fromStatus: "shipping",
          toStatus: "delivered",
          event: ORDER_EVENTS.COMPLETED,
          actor: SYSTEM_ACTOR,
        }),
      },
    }
  );

  if (result.modifiedCount === 0) {
    return false;
  }

  notifyOrderEvent(orderId, "order_completed");

  // Giữ logic cũ: cộng tổng chi tiêu cho khách khi đơn hoàn tất
  const amountToAdd = Number(order.Total_amount) || 0;
  if (order.User_id && amountToAdd > 0) {
    await User.updateOne(
      { User_id: order.User_id },
      { $inc: { Total_spent: amountToAdd } }
    );
  }

  return true;
}

module.exports = {
  ORDER_EVENTS,
  SYSTEM_ACTOR,
  buildHistoryEntry,
  hasHistoryEvent,
  isOrderConfirmed,
  hasCustomerConfirmation,
  tryCompleteOrder,
};
