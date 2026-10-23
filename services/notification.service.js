const crypto = require("crypto");
const Notification = require("../models/notification.model");
const { Order, Payment } = require("../models/schema");
const socketService = require("./socket.service");

const CUSTOMER_ORDER_LINK = "/order-history";

function adminOrderLink(orderId) {
  return `/admin/orders?orderId=${encodeURIComponent(orderId)}`;
}

function formatMoney(value) {
  return `${(Number(value) || 0).toLocaleString("vi-VN")}₫`;
}

function buildNotificationId() {
  return `NTF${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
}

// Dữ liệu trả về cho frontend
function toClient(doc, viewerId = "") {
  return {
    id: doc.Notification_id,
    type: doc.Type,
    title: doc.Title,
    message: doc.Message || "",
    orderId: doc.Order_id || "",
    link: doc.Link || "",
    createdAt: doc.Created_at,
    isRead: Boolean(viewerId) && (doc.Read_by || []).includes(viewerId),
  };
}

async function createNotification({ audience, userId = "", type, title, message = "", orderId = "", link = "" }) {
  const doc = await Notification.create({
    Notification_id: buildNotificationId(),
    Audience: audience,
    User_id: audience === "customer" ? userId : "",
    Type: type,
    Title: title,
    Message: message,
    Order_id: orderId,
    Link: link,
  });

  const payload = toClient(doc.toObject());
  if (audience === "admin") {
    socketService.emitToAdmins(payload);
  } else {
    socketService.emitToUser(userId, payload);
  }

  return doc;
}

// Nội dung thông báo gửi khách theo từng sự kiện của đơn hàng
const CUSTOMER_TEMPLATES = {
  order_created: (o) => ({
    title: "Đặt hàng thành công",
    message: `Đơn #${o.Order_id} đã được ghi nhận. Cửa hàng sẽ sớm xác nhận đơn của bạn.`,
  }),
  order_confirmed: (o) => ({
    title: "Đơn hàng đã được xác nhận",
    message: `Cửa hàng đã xác nhận đơn #${o.Order_id} và đang chuẩn bị hàng.`,
  }),
  order_cancelled_by_staff: (o) => ({
    title: "Đơn hàng đã bị hủy",
    message: `Cửa hàng đã hủy đơn #${o.Order_id}.${o.Cancel_reason ? ` Lý do: ${o.Cancel_reason}` : ""}`,
  }),
  order_handed_over: (o) => ({
    title: "Đơn hàng đang được giao",
    message: `Đơn #${o.Order_id} đã được bàn giao cho đơn vị vận chuyển và đang trên đường giao đến bạn.`,
  }),
  // Đơn chuyển khoản: chỉ báo đặt hàng thành công khi đã nhận tiền
  payment_confirmed: (o) => ({
    title: "Đặt hàng thành công",
    message: `Đã nhận thanh toán cho đơn #${o.Order_id}. Cửa hàng sẽ sớm xác nhận đơn của bạn.`,
  }),
  order_delivered: (o) => ({
    title: "Đơn hàng đã được giao",
    message: `Đơn #${o.Order_id} đã giao thành công. Vui lòng xác nhận bạn đã nhận được hàng.`,
  }),
  order_completed: (o) => ({
    title: "Đơn hàng hoàn tất",
    message: `Đơn #${o.Order_id} đã hoàn tất. Hãy đánh giá sản phẩm để giúp VISTA phục vụ tốt hơn nhé!`,
  }),
  return_requested: (o) => ({
    title: "Đã gửi yêu cầu hoàn trả",
    message: `Yêu cầu hoàn trả cho đơn #${o.Order_id} đã được ghi nhận.`,
  }),
};

// Nội dung thông báo gửi Admin
const ADMIN_TEMPLATES = {
  order_created: (o) => ({
    title: "Đơn hàng mới",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"} · ${formatMoney(o.Total_amount)}`,
  }),
  // Đơn chuyển khoản chỉ đến tay Admin khi khách đã thanh toán xong
  payment_confirmed: (o) => ({
    title: "Đơn hàng mới",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"} · ${formatMoney(o.Total_amount)} · Đã chuyển khoản`,
  }),
  order_cancelled_by_customer: (o) => ({
    title: "Khách hàng đã hủy đơn",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"}${o.Cancel_reason ? ` · Lý do: ${o.Cancel_reason}` : ""}`,
  }),
  order_completed: (o) => ({
    title: "Đơn hàng hoàn tất",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"} · ${formatMoney(o.Total_amount)}`,
  }),
  return_requested: (o) => ({
    title: "Yêu cầu hoàn trả mới",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"}`,
  }),
  sla_confirm_overdue: (o) => ({
    title: "Đơn quá hạn xác nhận",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"} · đã chờ xác nhận hơn 2 giờ`,
  }),
  sla_hand_over_overdue: (o) => ({
    title: "Đơn quá hạn bàn giao",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"} · đã xác nhận hơn 24 giờ nhưng chưa bàn giao`,
  }),
};

// Admin chỉ thấy đơn đã chốt: COD hiện ngay, chuyển khoản chỉ khi đã thanh toán
// (đơn đã thanh toán rồi bị hủy → refunded vẫn hiện)
function isVisibleToAdmin(order, payment) {
  if (!order || order.Status === "pending_payment") return false;
  if (payment?.Payment_type !== "BankTransfer") return true;
  return ["paid", "refunded"].includes(payment?.Payment_status);
}

// Tạo thông báo cho một sự kiện đơn hàng. Không bao giờ ném lỗi ra ngoài
// để lỗi thông báo không làm hỏng luồng xử lý đơn.
async function notifyOrderEvent(orderId, event) {
  try {
    const order = await Order.findOne({ Order_id: orderId })
      .select("Order_id User_id Status Receiver_name Total_amount Cancel_reason")
      .lean();

    if (!order) return;

    socketService.emitOrderUpdated(order.User_id, { orderId: order.Order_id, event });

    const tasks = [];
    // Đơn chuyển khoản vừa tạo (chờ thanh toán) chưa phải đặt hàng thành công
    // → chưa báo khách, đợi sự kiện payment_confirmed
    const isAwaitingPayment = event === "order_created" && order.Status === "pending_payment";
    const customerTemplate = isAwaitingPayment ? null : CUSTOMER_TEMPLATES[event];
    if (customerTemplate && order.User_id) {
      tasks.push(
        createNotification({
          audience: "customer",
          userId: order.User_id,
          type: event,
          orderId: order.Order_id,
          link: CUSTOMER_ORDER_LINK,
          ...customerTemplate(order),
        })
      );
    }

    const adminTemplate = ADMIN_TEMPLATES[event];
    const payment = adminTemplate
      ? await Payment.findOne({ Order_id: order.Order_id }).select("Payment_type Payment_status").lean()
      : null;
    if (adminTemplate && isVisibleToAdmin(order, payment)) {
      tasks.push(
        createNotification({
          audience: "admin",
          type: event,
          orderId: order.Order_id,
          link: adminOrderLink(order.Order_id),
          ...adminTemplate(order),
        })
      );
    }

    await Promise.all(tasks);
  } catch (error) {
    console.error(`Lỗi tạo thông báo (${event}, ${orderId}):`, error);
  }
}

module.exports = {
  toClient,
  createNotification,
  notifyOrderEvent,
};
