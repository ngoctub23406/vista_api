const crypto = require("crypto");
const Notification = require("../models/notification.model");
const { Order, Payment, User } = require("../models/schema");
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

// Dữ liệu trả về cho client / frontend
function toClient(doc, viewerId = "") {
  const isRead = Boolean(viewerId) && (doc.Read_by || []).includes(viewerId);
  const myRecipient =
    viewerId && Array.isArray(doc.Recipients)
      ? doc.Recipients.find((r) => r.User_id === viewerId)
      : null;

  const clientObj = {
    id: doc.Notification_id,
    type: doc.Type,
    title: doc.Title,
    message: doc.Message || "",
    orderId: doc.Order_id || "",
    link: doc.Link || "",
    createdAt: doc.Created_at,
    isRead: isRead || Boolean(myRecipient?.Read_at),
  };

  // Mở rộng dữ liệu cho thông báo vận hành
  if (doc.Audience === "staff_operational" || doc.Priority) {
    clientObj.audience = doc.Audience;
    clientObj.priority = doc.Priority || "normal";
    clientObj.senderId = doc.Sender_id || "";
    clientObj.senderName = doc.Sender_name || "";
    clientObj.targetEntity = doc.Target_entity || { Entity_type: "system", Entity_id: "" };

    // Trạng thái tiếp nhận độc lập của người xem (nếu người xem là Staff nhận việc)
    if (myRecipient) {
      clientObj.status = myRecipient.Status || "sent";
      clientObj.acknowledgedAt = myRecipient.Acknowledged_at || null;
      clientObj.readAt = myRecipient.Read_at || null;
    }

    // Nếu người xem là Manager người gửi: cung cấp thông tin thống kê người nhận
    if (viewerId && viewerId === doc.Sender_id && Array.isArray(doc.Recipients)) {
      clientObj.recipients = doc.Recipients.map((r) => ({
        userId: r.User_id,
        status: r.Status,
        readAt: r.Read_at,
        acknowledgedAt: r.Acknowledged_at,
      }));
      clientObj.recipientCount = doc.Recipients.length;
      clientObj.acknowledgedCount = doc.Recipients.filter((r) => r.Status === "acknowledged").length;
    }
  }

  return clientObj;
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

// Nội dung thông báo gửi Admin (Chỉ gửi các thông báo cần nhân sự/quản lý can thiệp xử lý)
const ADMIN_TEMPLATES = {
  order_created: (o) => ({
    title: "Đơn hàng mới",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"} · ${formatMoney(o.Total_amount)}`,
  }),
  payment_confirmed: (o) => ({
    title: "Đơn hàng mới",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"} · ${formatMoney(o.Total_amount)} · Đã chuyển khoản`,
  }),
  order_cancelled_by_customer: (o) => ({
    title: "Khách hàng đã hủy đơn",
    message: `#${o.Order_id} · ${o.Receiver_name || "Khách hàng"}${o.Cancel_reason ? ` · Lý do: ${o.Cancel_reason}` : ""}`,
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

function isVisibleToAdmin(order, payment) {
  if (!order || order.Status === "pending_payment") return false;
  if (payment?.Payment_type !== "BankTransfer") return true;
  return ["paid", "refunded"].includes(payment?.Payment_status);
}

async function notifyOrderEvent(orderId, event) {
  try {
    const order = await Order.findOne({ Order_id: orderId })
      .select("Order_id User_id Status Receiver_name Total_amount Cancel_reason")
      .lean();

    if (!order) return;

    socketService.emitOrderUpdated(order.User_id, { orderId: order.Order_id, event });

    const tasks = [];
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

// =============================================================================
// GIAI ĐOẠN 1: OPERATIONAL NOTIFICATION SERVICES (MANAGER <-> STAFF)
// =============================================================================

const VALID_PRIORITIES = ["normal", "important", "urgent"];
const VALID_RECIPIENT_MODES = ["all_staff", "specific_staff"];
const VALID_ENTITY_TYPES = ["order", "return", "review", "system"];

/**
 * Manager phát thông báo vận hành tới Staff
 */
async function dispatchOperationalAlert({
  managerUser,
  title,
  message,
  priority = "normal",
  recipientMode,
  recipientIds = [],
  targetEntity = null,
  link = "",
  idempotencyKey = null,
  confirmResend = false,
}) {
  // 1. Kiểm tra tính hợp lệ của Manager từ Database
  if (!managerUser || managerUser.Role !== "Manager") {
    const err = new Error("Chỉ Manager mới có quyền phát thông báo vận hành");
    err.statusCode = 403;
    throw err;
  }

  const manager = await User.findOne({ User_id: managerUser.User_id })
    .select("User_id Full_name Username Role Status")
    .lean();

  if (!manager || manager.Role !== "Manager" || manager.Status === "blocked") {
    const err = new Error("Tài khoản Manager không tồn tại hoặc đã bị khóa");
    err.statusCode = 403;
    throw err;
  }

  // 2. Validate tiêu đề và nội dung
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  if (!cleanTitle || cleanTitle.length < 3 || cleanTitle.length > 200) {
    const err = new Error("Tiêu đề thông báo bắt buộc, có độ dài từ 3 đến 200 ký tự");
    err.statusCode = 400;
    err.field = "title";
    throw err;
  }

  const cleanMessage = typeof message === "string" ? message.trim() : "";
  if (!cleanMessage || cleanMessage.length < 5 || cleanMessage.length > 2000) {
    const err = new Error("Nội dung thông báo bắt buộc, có độ dài từ 5 đến 2000 ký tự");
    err.statusCode = 400;
    err.field = "message";
    throw err;
  }

  // 3. Validate Priority
  const cleanPriority = String(priority || "normal").toLowerCase().trim();
  if (!VALID_PRIORITIES.includes(cleanPriority)) {
    const err = new Error(`Mức độ ưu tiên không hợp lệ. Cho phép: ${VALID_PRIORITIES.join(", ")}`);
    err.statusCode = 400;
    err.field = "priority";
    throw err;
  }

  // 4. Validate Recipient Mode
  if (!VALID_RECIPIENT_MODES.includes(recipientMode)) {
    const err = new Error(`Chế độ người nhận không hợp lệ. Cho phép: ${VALID_RECIPIENT_MODES.join(", ")}`);
    err.statusCode = 400;
    err.field = "recipient_mode";
    throw err;
  }

  // 5. Xác định danh sách Staff hợp lệ
  let targetStaffIds = [];

  if (recipientMode === "all_staff") {
    const activeStaff = await User.find({ Role: "Staff", Status: "active" })
      .select("User_id Full_name Status")
      .lean();

    if (!activeStaff || activeStaff.length === 0) {
      const err = new Error("Không có nhân viên Staff nào đang hoạt động trong hệ thống");
      err.statusCode = 400;
      throw err;
    }
    targetStaffIds = activeStaff.map((s) => s.User_id);
  } else {
    // specific_staff
    const rawIds = Array.isArray(recipientIds) ? recipientIds : [recipientIds];
    const uniqueIds = [...new Set(rawIds.map((id) => String(id || "").trim()).filter(Boolean))];

    if (uniqueIds.length === 0) {
      const err = new Error("Vui lòng chọn ít nhất một nhân viên Staff nhận thông báo");
      err.statusCode = 400;
      err.field = "recipient_ids";
      throw err;
    }

    // Kiểm tra từng nhân viên: phải tồn tại, có Role: 'Staff' và Status: 'active'
    const staffRecords = await User.find({ User_id: { $in: uniqueIds } })
      .select("User_id Role Status Full_name")
      .lean();

    const staffMap = new Map(staffRecords.map((s) => [s.User_id, s]));

    for (const uid of uniqueIds) {
      const staff = staffMap.get(uid);
      if (!staff) {
        const err = new Error(`Nhân viên có mã '${uid}' không tồn tại trong hệ thống`);
        err.statusCode = 400;
        err.field = "recipient_ids";
        throw err;
      }
      if (staff.Role !== "Staff") {
        const err = new Error(`Tài khoản '${uid}' không phải là nhân viên Staff (Role: ${staff.Role})`);
        err.statusCode = 400;
        err.field = "recipient_ids";
        throw err;
      }
      if (staff.Status !== "active") {
        const err = new Error(`Tài khoản Staff '${uid}' đang bị khóa hoặc ngưng hoạt động`);
        err.statusCode = 400;
        err.field = "recipient_ids";
        throw err;
      }
    }

    targetStaffIds = uniqueIds;
  }

  // 6. Kiểm tra Idempotency Key & Gửi trùng lặp
  const cleanKey = typeof idempotencyKey === "string" ? idempotencyKey.trim() : null;
  if (cleanKey) {
    const existingKeyDoc = await Notification.findOne({
      Audience: "staff_operational",
      Sender_id: manager.User_id,
      Idempotency_key: cleanKey,
    });
    if (existingKeyDoc) {
      return {
        doc: existingKeyDoc,
        client: toClient(existingKeyDoc.toObject(), manager.User_id),
        isDuplicate: true,
        message: "Thông báo đã tồn tại theo Idempotency Key",
      };
    }
  }

  // Kiểm soát chống spam gửi lặp trong 60 giây (nếu không có confirmResend)
  if (!confirmResend) {
    const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
    const recentDuplicate = await Notification.findOne({
      Audience: "staff_operational",
      Sender_id: manager.User_id,
      Title: cleanTitle,
      Created_at: { $gte: sixtySecondsAgo },
    });

    if (recentDuplicate) {
      const err = new Error(
        "Thông báo có cùng tiêu đề vừa được gửi cách đây chưa đầy 1 phút. Gửi kèm 'confirm_resend: true' nếu bạn thực sự muốn gửi tiếp."
      );
      err.statusCode = 409;
      err.code = "DUPLICATE_RECENT_ALERT";
      throw err;
    }
  }

  // 7. Validate Target Entity
  let entityType = "system";
  let entityId = "";
  if (targetEntity && typeof targetEntity === "object") {
    if (targetEntity.entity_type && VALID_ENTITY_TYPES.includes(String(targetEntity.entity_type).toLowerCase())) {
      entityType = String(targetEntity.entity_type).toLowerCase();
    }
    if (targetEntity.entity_id) {
      entityId = String(targetEntity.entity_id).trim();
    }
  }

  // 8. Chuẩn bị Recipients độc lập cho từng Staff
  const recipients = targetStaffIds.map((userId) => ({
    User_id: userId,
    Status: "sent",
    Read_at: null,
    Acknowledged_at: null,
  }));

  // 9. Tạo Notification trong MongoDB
  const notificationId = buildNotificationId();
  const createdDoc = await Notification.create({
    Notification_id: notificationId,
    Audience: "staff_operational",
    Type: "operational_alert",
    Sender_id: manager.User_id,
    Sender_name: manager.Full_name || manager.Username || "Quản lý VISTA",
    Title: cleanTitle,
    Message: cleanMessage,
    Priority: cleanPriority,
    Target_entity: {
      Entity_type: entityType,
      Entity_id: entityId,
    },
    Order_id: entityType === "order" ? entityId : "",
    Link: link || (entityType === "order" && entityId ? adminOrderLink(entityId) : ""),
    Recipients: recipients,
    Idempotency_key: cleanKey,
    Created_at: new Date(),
  });

  // 10. Phát Socket.IO Realtime đến từng Staff trong Recipients (Chỉ sau khi lưu DB thành công)
  if (Array.isArray(createdDoc.Recipients)) {
    for (const recipient of createdDoc.Recipients) {
      try {
        const staffPayload = toClient(createdDoc.toObject(), recipient.User_id);
        socketService.emitToUser(recipient.User_id, staffPayload);
      } catch (socketError) {
        // Cách ly lỗi: lỗi phát tới một Staff không làm gián đoạn các Staff tiếp theo
        // và không làm hỏng kết quả trả về khi dữ liệu đã lưu MongoDB thành công
        console.error(
          `[Socket] Lỗi phát thông báo tới nhân viên ${recipient.User_id}:`,
          socketError?.message || socketError
        );
      }
    }
  }

  return {
    doc: createdDoc,
    client: toClient(createdDoc.toObject(), manager.User_id),
    isDuplicate: false,
    message: "Đã phát thông báo vận hành thành công",
  };
}

/**
 * Staff xác nhận đã tiếp nhận thông báo
 */
async function acknowledgeNotification({ notificationId, userId }) {
  if (!notificationId || typeof notificationId !== "string") {
    const err = new Error("Mã thông báo không hợp lệ");
    err.statusCode = 400;
    throw err;
  }

  if (!userId || typeof userId !== "string") {
    const err = new Error("Mã người dùng không hợp lệ");
    err.statusCode = 400;
    throw err;
  }

  // Tìm thông báo vận hành
  const cleanId = notificationId.trim();
  const doc = await Notification.findOne({
    Notification_id: cleanId,
    Audience: "staff_operational",
  });

  if (!doc) {
    const err = new Error("Không tìm thấy thông báo vận hành");
    err.statusCode = 404;
    throw err;
  }

  // Kiểm tra người thao tác có nằm trong danh sách Recipients không
  const recipientEntry = (doc.Recipients || []).find((r) => r.User_id === userId);
  if (!recipientEntry) {
    const err = new Error("Bạn không thuộc danh sách người nhận thông báo này");
    err.statusCode = 403;
    throw err;
  }

  // Idempotency: nếu đã tiếp nhận từ trước, giữ nguyên Acknowledged_at ban đầu
  if (recipientEntry.Status === "acknowledged") {
    return {
      success: true,
      alreadyAcknowledged: true,
      message: "Thông báo này đã được bạn xác nhận tiếp nhận trước đó",
      data: toClient(doc.toObject(), userId),
    };
  }

  // Cập nhật nguyên tử trạng thái của duy nhất người này
  const now = new Date();
  const updatedDoc = await Notification.findOneAndUpdate(
    {
      Notification_id: cleanId,
      "Recipients.User_id": userId,
    },
    {
      $set: {
        "Recipients.$.Status": "acknowledged",
        "Recipients.$.Acknowledged_at": now,
      },
      $addToSet: { Read_by: userId },
    },
    { returnDocument: "after" }
  );

  return {
    success: true,
    alreadyAcknowledged: false,
    message: "Đã xác nhận tiếp nhận thông báo thành công",
    data: toClient(updatedDoc.toObject(), userId),
  };
}

/**
 * Manager xem lịch sử thông báo do mình gửi
 */
async function getSentNotifications({ senderId, page = 1, limit = 20, priority = null }) {
  const cleanPage = Math.max(1, Number(page) || 1);
  const cleanLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (cleanPage - 1) * cleanLimit;

  const query = {
    Audience: "staff_operational",
    Sender_id: senderId,
  };

  if (priority && VALID_PRIORITIES.includes(priority.toLowerCase())) {
    query.Priority = priority.toLowerCase();
  }

  const [items, total] = await Promise.all([
    Notification.find(query).sort({ Created_at: -1 }).skip(skip).limit(cleanLimit).lean(),
    Notification.countDocuments(query),
  ]);

  return {
    items: items.map((doc) => toClient(doc, senderId)),
    pagination: {
      page: cleanPage,
      limit: cleanLimit,
      total,
      totalPages: Math.ceil(total / cleanLimit) || 1,
    },
  };
}

/**
 * Staff xem các thông báo vận hành được giao cho mình
 */
async function getAssignedNotifications({ staffId, page = 1, limit = 20, status = null, priority = null }) {
  const cleanPage = Math.max(1, Number(page) || 1);
  const cleanLimit = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (cleanPage - 1) * cleanLimit;

  const query = {
    Audience: "staff_operational",
    "Recipients.User_id": staffId,
  };

  if (priority && VALID_PRIORITIES.includes(priority.toLowerCase())) {
    query.Priority = priority.toLowerCase();
  }

  if (status && ["sent", "acknowledged"].includes(status.toLowerCase())) {
    query.Recipients = {
      $elemMatch: {
        User_id: staffId,
        Status: status.toLowerCase(),
      },
    };
  }

  const [items, total] = await Promise.all([
    Notification.find(query).sort({ Created_at: -1 }).skip(skip).limit(cleanLimit).lean(),
    Notification.countDocuments(query),
  ]);

  return {
    items: items.map((doc) => toClient(doc, staffId)),
    pagination: {
      page: cleanPage,
      limit: cleanLimit,
      total,
      totalPages: Math.ceil(total / cleanLimit) || 1,
    },
  };
}

module.exports = {
  toClient,
  createNotification,
  notifyOrderEvent,
  dispatchOperationalAlert,
  acknowledgeNotification,
  getSentNotifications,
  getAssignedNotifications,
};
