const { Delivery } = require("../models/schema");

// Giả lập API đơn vị vận chuyển cấp mã vận đơn
let trackingSequence = 0;
function requestTrackingNumber() {
  trackingSequence = (trackingSequence + 1) % 100;
  return `VS${Date.now().toString().slice(-8)}${String(trackingSequence).padStart(2, "0")}`;
}

// Gắn mã vận đơn vào thông tin giao hàng của đơn
async function assignTrackingNumber(orderId, trackingNumber) {
  await Delivery.updateOne(
    { Order_id: orderId },
    {
      $set: { Tracking_number: trackingNumber },
      $setOnInsert: {
        Delivery_id: `DLV${Date.now()}`,
        Shipping_partner: "Đơn vị vận chuyển",
        Status: "pending",
      },
    },
    { upsert: true }
  );
}

module.exports = { requestTrackingNumber, assignTrackingNumber };
