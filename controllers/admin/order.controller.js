const {
  Order,
  Order_detail,
  Payment,
  Delivery,
  Product_variant,
  User,
  Return_order,
} = require("../../models/schema");
const {
  ORDER_EVENTS,
  buildHistoryEntry,
  hasHistoryEvent,
  isOrderConfirmed,
  SYSTEM_ACTOR,
} = require("../../services/order-status.service");
const { notifyOrderEvent } = require("../../services/notification.service");
const { buildSlaStages, computeSla } = require("../../services/order-sla.service");
const {
  STAFF_CANCEL_REASONS,
  CUSTOMER_CANCEL_REASONS,
  SYSTEM_CANCEL_REASONS,
  findByCode,
} = require("../../services/reason-catalog");
const { requestTrackingNumber, assignTrackingNumber } = require("../../services/tracking.service");

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const MAX_BULK_SIZE = 50;
const CANCELLABLE_STATUSES = ["processing", "pending_payment"];
const DISPLAY_STATUSES = [
  "pending_confirmation",
  "processing",
  "shipping",
  "completed",
  "cancelled",
  "returning",
];
const FAR_FUTURE = new Date("9999-12-31T00:00:00Z");

function cleanText(value) {
  return String(value || "").trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lấy tên Staff để ghi vào lịch sử trạng thái
async function getActor(req) {
  const user = await User.findOne({ User_id: req.user?.User_id })
    .select("Full_name Username Email")
    .lean();

  return {
    id: req.user?.User_id || "",
    name: user?.Full_name || user?.Username || req.user?.Email || "Staff",
  };
}

// Trạng thái hiển thị trên giao diện, ánh xạ từ Order.Status hiện có
function getDisplayStatus(order) {
  const status = cleanText(order.Status);

  if (status === "cancelled") return "cancelled";
  if (status === "returning") return "returning";
  if (status === "delivered" || status === "review") return "completed";
  if (status === "shipping" || status === "delivering") return "shipping";

  return isOrderConfirmed(order) ? "processing" : "pending_confirmation";
}

// Các thao tác Staff được phép làm ở bước hiện tại
// Mã vận đơn được tạo tự động khi xác nhận đơn, nên không còn bước "tạo đơn vận chuyển"
function getAvailableActions(order, displayStatus) {
  // Chỉ in nhãn được khi đơn đã có mã vận đơn
  const printable = hasHistoryEvent(order, ORDER_EVENTS.SHIPMENT_CREATED) ? ["print_label"] : [];

  if (displayStatus === "pending_confirmation") {
    return ["confirm", "cancel"];
  }

  if (displayStatus === "processing") {
    return hasHistoryEvent(order, ORDER_EVENTS.HANDED_OVER) ? printable : ["hand_over", ...printable];
  }

  if (displayStatus === "shipping") {
    return printable;
  }

  return [];
}

// Admin chỉ thấy đơn đã "chốt": COD hiện ngay, chuyển khoản chỉ hiện khi đã thanh toán
// (hoặc đã thanh toán rồi bị hủy → refunded). Đơn chờ thanh toán không hiện.
const ADMIN_VISIBLE_MATCH = {
  $or: [
    { "PaymentInfo.Payment_type": { $ne: "BankTransfer" } },
    { "PaymentInfo.Payment_status": { $in: ["paid", "refunded"] } },
  ],
};

function isVisibleToAdmin(order, payment) {
  if (!order || order.Status === "pending_payment") return false;
  if (payment?.Payment_type !== "BankTransfer") return true;
  return ["paid", "refunded"].includes(payment?.Payment_status);
}

function formatOrderSummary(order, payment, delivery) {
  const displayStatus = getDisplayStatus(order);
  const sla = computeSla(order, displayStatus);

  return {
    Order_id: order.Order_id,
    Customer_name: order.Receiver_name || "",
    Created_at: order.Created_at,
    Total_amount: order.Total_amount || 0,
    Status: order.Status,
    Display_status: displayStatus,
    Payment_type: payment?.Payment_type || "",
    Payment_status: payment?.Payment_status || "pending",
    Delivery_status: delivery?.Status || "pending",
    Tracking_number: hasHistoryEvent(order, ORDER_EVENTS.SHIPMENT_CREATED)
      ? delivery?.Tracking_number || ""
      : "",
    Available_actions: getAvailableActions(order, displayStatus),
    ...sla,
  };
}

// Danh mục lý do hủy cho Staff
exports.getCancelReasons = (req, res) => {
  return res.json({ success: true, data: STAFF_CANCEL_REASONS });
};

// Staff, Manager xem danh sách đơn hàng (kèm số đếm từng trạng thái và SLA)
exports.getOrders = async (req, res) => {
  try {
    const keyword = cleanText(req.query.keyword);
    const status = cleanText(req.query.status);
    const fromDate = cleanText(req.query.fromDate);
    const toDate = cleanText(req.query.toDate);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE_SIZE));

    // Bộ lọc chung (áp dụng cho cả danh sách và số đếm trên tab)
    const baseMatch = { Status: { $ne: "pending_payment" } };

    if (keyword) {
      const regex = new RegExp(escapeRegex(keyword), "i");
      baseMatch.$or = [{ Order_id: regex }, { Receiver_name: regex }];
    }

    if (fromDate || toDate) {
      baseMatch.Created_at = {};
      if (fromDate) baseMatch.Created_at.$gte = new Date(`${fromDate}T00:00:00`);
      if (toDate) baseMatch.Created_at.$lte = new Date(`${toDate}T23:59:59.999`);
    }

    // Bộ lọc theo tab đang chọn
    let tabMatch = {};
    if (status === "overdue") {
      tabMatch = { Is_overdue: true };
    } else if (DISPLAY_STATUSES.includes(status)) {
      tabMatch = { Display_status: status };
    }

    const [result] = await Order.aggregate([
      { $match: baseMatch },
      {
        $lookup: {
          from: "Payment",
          localField: "Order_id",
          foreignField: "Order_id",
          as: "PaymentInfo",
        },
      },
      { $unwind: { path: "$PaymentInfo", preserveNullAndEmptyArrays: true } },
      { $match: ADMIN_VISIBLE_MATCH },
      ...buildSlaStages(new Date()),
      {
        $facet: {
          counts: [{ $group: { _id: "$Display_status", count: { $sum: 1 } } }],
          overdue: [{ $match: { Is_overdue: true } }, { $count: "count" }],
          total: [{ $match: tabMatch }, { $count: "count" }],
          items: [
            { $match: tabMatch },
            // Ưu tiên theo hạn xử lý: quá hạn lâu nhất → sắp hết hạn → còn nhiều thời gian;
            // đơn không có hạn (đang giao, hoàn tất...) xếp sau, mới nhất trước
            { $addFields: { _sortDeadline: { $ifNull: ["$Sla_deadline", FAR_FUTURE] } } },
            { $sort: { Is_overdue: -1, _sortDeadline: 1, Created_at: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $lookup: {
                from: "Delivery",
                localField: "Order_id",
                foreignField: "Order_id",
                as: "DeliveryInfo",
              },
            },
          ],
        },
      },
    ]);

    const counts = { all: 0, overdue: result?.overdue?.[0]?.count || 0 };
    DISPLAY_STATUSES.forEach((key) => {
      counts[key] = 0;
    });
    (result?.counts || []).forEach((item) => {
      counts[item._id] = item.count;
      counts.all += item.count;
    });

    const items = (result?.items || []).map((order) =>
      formatOrderSummary(order, order.PaymentInfo, order.DeliveryInfo?.[0])
    );

    return res.json({
      success: true,
      data: {
        items,
        total: result?.total?.[0]?.count || 0,
        page,
        limit,
        counts,
      },
    });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách đơn hàng:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tải danh sách đơn hàng",
    });
  }
};

// Đơn cũ (tạo trước khi có Status_history) thiếu các mốc cuối: hủy, hoàn tất, hoàn trả.
// Dựng lại từ dữ liệu sẵn có để dòng thời gian không bị cụt. Không ghi vào DB.
function inferCancelActor(order) {
  if (order.Cancelled_by === "customer") return "Khách hàng";
  if (order.Cancelled_by === "staff") return "Staff";
  if (order.Cancelled_by === "system") return SYSTEM_ACTOR.name;

  const reason = cleanText(order.Cancel_reason);
  if (CUSTOMER_CANCEL_REASONS.some((item) => item.label === reason)) return "Khách hàng";
  if (SYSTEM_CANCEL_REASONS.some((item) => item.label === reason)) return SYSTEM_ACTOR.name;
  return "Không rõ người thực hiện";
}

function buildDisplayHistory(order, delivery, returnRequest) {
  const history = [...(order.Status_history || [])];
  const has = (event) => history.some((item) => item.Event === event);
  const inferred = (entry) => ({ ...entry, Is_inferred: true });

  if (order.Status === "cancelled" && !has(ORDER_EVENTS.CANCELLED)) {
    history.push(inferred({
      Event: ORDER_EVENTS.CANCELLED,
      To_status: "cancelled",
      Actor_name: inferCancelActor(order),
      Note: order.Cancel_reason || "",
      Created_at: order.Cancelled_at || null,
    }));
  }

  if (["delivered", "review", "returning"].includes(order.Status) && !has(ORDER_EVENTS.COMPLETED)) {
    history.push(inferred({
      Event: ORDER_EVENTS.COMPLETED,
      To_status: "delivered",
      Actor_name: SYSTEM_ACTOR.name,
      Note: "",
      Created_at: delivery?.Delivered_at || null,
    }));
  }

  if (order.Status === "returning" && !has(ORDER_EVENTS.RETURN_REQUESTED)) {
    history.push(inferred({
      Event: ORDER_EVENTS.RETURN_REQUESTED,
      To_status: "returning",
      Actor_name: "Khách hàng",
      Note: returnRequest?.Reason_type || "",
      Created_at: returnRequest?.Created_at || null,
    }));
  }

  return history;
}

async function loadOrderDetail(orderId) {
  const order = await Order.findOne({ Order_id: orderId }).lean();
  if (!order) return null;

  const [payment, delivery, returnRequest, items] = await Promise.all([
    Payment.findOne({ Order_id: orderId }).lean(),
    Delivery.findOne({ Order_id: orderId }).lean(),
    order.Status === "returning"
      ? Return_order.findOne({ Order_id: orderId }).sort({ Created_at: 1 }).lean()
      : null,
    Order_detail.aggregate([
      { $match: { Order_id: orderId } },
      {
        $lookup: {
          from: "Product_variant",
          localField: "Product_variant_id",
          foreignField: "Product_variant_id",
          as: "VariantInfo",
        },
      },
      { $unwind: { path: "$VariantInfo", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "Product",
          localField: "VariantInfo.Product_id",
          foreignField: "Product_id",
          as: "ProductInfo",
        },
      },
      { $unwind: { path: "$ProductInfo", preserveNullAndEmptyArrays: true } },
    ]),
  ]);

  if (!isVisibleToAdmin(order, payment)) return null;

  return {
    ...formatOrderSummary(order, payment, delivery),
    Receiver_name: order.Receiver_name || "",
    Receiver_phone: order.Receiver_phone || "",
    Email: order.Email || "",
    Address: order.Address || [order.Specific_address, order.Ward, order.District, order.Province]
      .filter(Boolean)
      .join(", "),
    Order_notes: order.Order_notes || "",
    Total_items_price: order.Total_items_price || 0,
    Discount_amount: order.Discount_amount || 0,
    Shipping_fee: Number(delivery?.Shipping_fee) || 0,
    Cancel_reason: order.Cancel_reason || "",
    Cancel_reason_code: order.Cancel_reason_code || "",
    Cancelled_by: order.Cancelled_by || "",
    Shipping_partner: delivery?.Shipping_partner || "",
    Delivered_at: delivery?.Delivered_at || null,
    Status_history: buildDisplayHistory(order, delivery, returnRequest),
    Items: items.map((item) => ({
      Product_variant_id: item.Product_variant_id,
      Product_name: item.ProductInfo?.Product_name || item.Variant_name,
      Variant_name: item.Variant_name,
      Image: item.ProductInfo?.Images?.length
        ? "/assets/images/" + item.ProductInfo.Images[0]
        : "/assets/images/default-product.png",
      Price: item.Price || 0,
      Quantity: item.Quantity || 0,
      Total_price: item.Total_price || (item.Price || 0) * (item.Quantity || 0),
    })),
  };
}

// Staff, Manager xem chi tiết đơn hàng
exports.getOrderDetail = async (req, res) => {
  try {
    const detail = await loadOrderDetail(cleanText(req.params.orderId));

    if (!detail) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy đơn hàng",
      });
    }

    return res.json({ success: true, data: detail });
  } catch (error) {
    console.error("Lỗi khi lấy chi tiết đơn hàng:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tải chi tiết đơn hàng",
    });
  }
};

// ===== Nghiệp vụ cập nhật đơn (dùng chung cho thao tác lẻ và hàng loạt) =====
// Mỗi hàm trả về { ok, status, message } thay vì tự gửi response

async function rejectedResult(orderId) {
  const exists = await Order.exists({ Order_id: orderId });

  if (!exists) {
    return { ok: false, status: 404, message: "Không tìm thấy đơn hàng" };
  }

  return {
    ok: false,
    status: 409,
    message: "Đơn hàng đã được cập nhật bởi người khác. Vui lòng tải lại để xem trạng thái mới nhất.",
  };
}

// Xác nhận đơn: Chờ xác nhận → Đang xử lý, hệ thống tự cấp mã vận đơn
async function confirmOne(orderId, actor, note) {
  const order = await Order.findOne({ Order_id: orderId }).select("Status").lean();

  if (order?.Status === "pending_payment") {
    return { ok: false, status: 400, message: "Đơn hàng chưa được thanh toán, chưa thể xác nhận" };
  }

  const now = new Date();
  const trackingNumber = requestTrackingNumber();

  const result = await Order.updateOne(
    {
      Order_id: orderId,
      Status: "processing",
      "Status_history.Event": { $ne: ORDER_EVENTS.CONFIRMED },
    },
    {
      $set: { Processing_started_at: now },
      $push: {
        Status_history: {
          $each: [
            buildHistoryEntry({
              fromStatus: "processing",
              toStatus: "processing",
              event: ORDER_EVENTS.CONFIRMED,
              actor,
              note,
            }),
            // Hệ thống tự tạo đơn vận chuyển ngay khi xác nhận
            buildHistoryEntry({
              fromStatus: "processing",
              toStatus: "processing",
              event: ORDER_EVENTS.SHIPMENT_CREATED,
              actor: SYSTEM_ACTOR,
              note: `Mã vận đơn: ${trackingNumber}`,
            }),
          ],
        },
      },
    }
  );

  if (result.modifiedCount === 0) {
    return rejectedResult(orderId);
  }

  await assignTrackingNumber(orderId, trackingNumber);
  notifyOrderEvent(orderId, "order_confirmed");

  return { ok: true, status: 200, message: "Đã xác nhận đơn hàng" };
}

// Bàn giao cho ĐVVC → đơn chuyển sang "Đang giao"
async function handOverOne(orderId, actor, note) {
  const result = await Order.updateOne(
    {
      Order_id: orderId,
      Status: "processing",
      "Status_history.Event": {
        $all: [ORDER_EVENTS.CONFIRMED],
        $nin: [ORDER_EVENTS.HANDED_OVER],
      },
    },
    {
      $set: { Status: "shipping" },
      $push: {
        Status_history: buildHistoryEntry({
          fromStatus: "processing",
          toStatus: "shipping",
          event: ORDER_EVENTS.HANDED_OVER,
          actor,
          note,
        }),
      },
    }
  );

  if (result.modifiedCount === 0) {
    return rejectedResult(orderId);
  }

  // Đơn cũ được xác nhận trước khi có mã vận đơn tự động thì cấp mã luôn lúc bàn giao
  const updatedOrder = await Order.findOne({ Order_id: orderId }).select("Status_history").lean();
  if (!hasHistoryEvent(updatedOrder, ORDER_EVENTS.SHIPMENT_CREATED)) {
    const trackingNumber = requestTrackingNumber();
    await assignTrackingNumber(orderId, trackingNumber);
    await Order.updateOne(
      { Order_id: orderId },
      {
        $push: {
          Status_history: buildHistoryEntry({
            fromStatus: "shipping",
            toStatus: "shipping",
            event: ORDER_EVENTS.SHIPMENT_CREATED,
            actor: SYSTEM_ACTOR,
            note: `Mã vận đơn: ${trackingNumber}`,
          }),
        },
      }
    );
  }

  await Delivery.updateOne({ Order_id: orderId }, { $set: { Status: "shipping" } });
  notifyOrderEvent(orderId, "order_handed_over");

  return { ok: true, status: 200, message: "Đã bàn giao cho đơn vị vận chuyển, đơn chuyển sang Đang giao" };
}

// Staff hủy đơn: chỉ khi đơn chưa được xác nhận, lý do chọn theo danh mục
async function cancelOne(orderId, actor, reasonCode, note) {
  const reason = findByCode(STAFF_CANCEL_REASONS, reasonCode);
  if (!reason) {
    return { ok: false, status: 400, message: "Vui lòng chọn lý do hủy đơn" };
  }

  if (reason.requiresNote && !note) {
    return { ok: false, status: 400, message: "Vui lòng ghi rõ lý do hủy đơn" };
  }

  const reasonText = note ? `${reason.label}: ${note}` : reason.label;
  const order = await Order.findOne({ Order_id: orderId }).select("Status").lean();
  const payment = await Payment.findOne({ Order_id: orderId }).lean();
  const needsRefund = payment?.Payment_status === "paid" && payment?.Payment_type !== "COD";
  const now = new Date();

  const result = await Order.updateOne(
    {
      Order_id: orderId,
      Status: { $in: CANCELLABLE_STATUSES },
      "Status_history.Event": { $ne: ORDER_EVENTS.CONFIRMED },
    },
    {
      $set: {
        Status: "cancelled",
        Cancel_reason: reasonText,
        Cancel_reason_code: reason.code,
        Cancelled_by: "staff",
        Cancelled_at: now,
      },
      $push: {
        Status_history: buildHistoryEntry({
          fromStatus: order?.Status,
          toStatus: "cancelled",
          event: ORDER_EVENTS.CANCELLED,
          actor,
          note: needsRefund ? `${reasonText} · Cần hoàn tiền cho khách` : reasonText,
        }),
      },
    }
  );

  if (result.modifiedCount === 0) {
    return rejectedResult(orderId);
  }

  // Hoàn trả tồn kho đã trừ lúc khách đặt hàng
  const orderDetails = await Order_detail.find({ Order_id: orderId }).lean();
  await Promise.all(
    orderDetails.map((item) =>
      Product_variant.updateOne(
        { Product_variant_id: item.Product_variant_id },
        { $inc: { Stock_quantity: Math.max(0, Number(item.Quantity) || 0) } }
      )
    )
  );

  notifyOrderEvent(orderId, "order_cancelled_by_staff");

  return { ok: true, status: 200, message: "Đã hủy đơn hàng" };
}

function sendResult(res, result) {
  return res.status(result.status).json({ success: result.ok, message: result.message });
}

exports.confirmOrder = async (req, res) => {
  try {
    const result = await confirmOne(cleanText(req.params.orderId), await getActor(req), req.body?.note);
    return sendResult(res, result);
  } catch (error) {
    console.error("Lỗi khi xác nhận đơn hàng:", error);
    return res.status(500).json({
      success: false,
      message: "Xác nhận đơn hàng thất bại, vui lòng thử lại",
    });
  }
};

exports.cancelOrder = async (req, res) => {
  try {
    // Hỗ trợ cả kiểu cũ (chỉ gửi "reason" dạng chữ) → xếp vào "Lý do khác"
    const reasonCode = cleanText(req.body?.reasonCode) || (cleanText(req.body?.reason) ? "other" : "");
    const note = cleanText(req.body?.note || (req.body?.reasonCode ? "" : req.body?.reason));

    const result = await cancelOne(cleanText(req.params.orderId), await getActor(req), reasonCode, note);
    return sendResult(res, result);
  } catch (error) {
    console.error("Lỗi khi hủy đơn hàng:", error);
    return res.status(500).json({
      success: false,
      message: "Hủy đơn hàng thất bại, vui lòng thử lại",
    });
  }
};

exports.handOverOrder = async (req, res) => {
  try {
    const result = await handOverOne(cleanText(req.params.orderId), await getActor(req), req.body?.note);
    return sendResult(res, result);
  } catch (error) {
    console.error("Lỗi khi bàn giao đơn hàng:", error);
    return res.status(500).json({
      success: false,
      message: "Bàn giao đơn hàng thất bại, vui lòng thử lại",
    });
  }
};

// Thao tác hàng loạt: xác nhận / bàn giao nhiều đơn một lần
const BULK_HANDLERS = {
  confirm: confirmOne,
  hand_over: handOverOne,
};

exports.bulkUpdate = async (req, res) => {
  try {
    const action = cleanText(req.body?.action);
    const handler = BULK_HANDLERS[action];
    const orderIds = [...new Set((Array.isArray(req.body?.orderIds) ? req.body.orderIds : []).map(cleanText))]
      .filter(Boolean);

    if (!handler) {
      return res.status(400).json({ success: false, message: "Thao tác không hợp lệ" });
    }

    if (!orderIds.length) {
      return res.status(400).json({ success: false, message: "Vui lòng chọn đơn hàng" });
    }

    if (orderIds.length > MAX_BULK_SIZE) {
      return res.status(400).json({
        success: false,
        message: `Mỗi lần chỉ xử lý tối đa ${MAX_BULK_SIZE} đơn`,
      });
    }

    const actor = await getActor(req);
    const note = cleanText(req.body?.note);
    const succeeded = [];
    const failed = [];

    // Chạy tuần tự để mã vận đơn và lịch sử không bị chồng chéo
    for (const orderId of orderIds) {
      try {
        const result = await handler(orderId, actor, note);
        if (result.ok) {
          succeeded.push(orderId);
        } else {
          failed.push({ orderId, message: result.message });
        }
      } catch (error) {
        console.error(`Lỗi thao tác hàng loạt (${action}, ${orderId}):`, error);
        failed.push({ orderId, message: "Lỗi hệ thống" });
      }
    }

    const label = action === "confirm" ? "xác nhận" : "bàn giao";
    return res.json({
      success: true,
      message: failed.length
        ? `Đã ${label} ${succeeded.length}/${orderIds.length} đơn, ${failed.length} đơn không thực hiện được`
        : `Đã ${label} ${succeeded.length} đơn`,
      data: { succeeded, failed },
    });
  } catch (error) {
    console.error("Lỗi thao tác hàng loạt:", error);
    return res.status(500).json({ success: false, message: "Thao tác hàng loạt thất bại, vui lòng thử lại" });
  }
};

// In nhãn hàng loạt: lấy thông tin nhãn của nhiều đơn một lần
exports.getLabels = async (req, res) => {
  try {
    const orderIds = [...new Set((Array.isArray(req.body?.orderIds) ? req.body.orderIds : []).map(cleanText))]
      .filter(Boolean)
      .slice(0, MAX_BULK_SIZE);

    const details = await Promise.all(orderIds.map((orderId) => loadOrderDetail(orderId)));
    const labels = details
      .filter((detail) => detail && detail.Tracking_number)
      .map((detail) => ({
        Order_id: detail.Order_id,
        Tracking_number: detail.Tracking_number,
        Shipping_partner: detail.Shipping_partner,
        Receiver_name: detail.Receiver_name,
        Receiver_phone: detail.Receiver_phone,
        Address: detail.Address,
        Payment_type: detail.Payment_type,
        Payment_status: detail.Payment_status,
        Total_amount: detail.Total_amount,
      }));

    return res.json({ success: true, data: labels });
  } catch (error) {
    console.error("Lỗi khi lấy nhãn vận đơn:", error);
    return res.status(500).json({ success: false, message: "Không thể tải nhãn vận đơn" });
  }
};
