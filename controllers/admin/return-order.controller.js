const { Return_order, Order, Order_detail, Product_variant, Product, User, Payment } = require("../../models/schema");
const { createNotification } = require("../../services/notification.service");
const { ORDER_EVENTS, buildHistoryEntry } = require("../../services/order-status.service");

// Danh sách các trường tóm tắt cần hiển thị trên bảng danh sách (tương tự formatOrderSummary trong order.controller)
const RETURN_SUMMARY_FIELDS = [
  "_id",
  "Return_order_id",
  "Order_id",
  "Product_variant_id",
  "Return_name",
  "Return_phone",
  "Reason_type",
  "Description",
  "Refund_amount",
  "Return_quantity",
  "Status",
  "Created_at",
  "Handled_by",
  "Handled_by_name",
  "Handled_at",
  "Reject_reason",
  "Inspected_by",
  "Inspected_by_name",
  "Inspected_at",
  "Inspected_result",
].join(" ");

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Chuẩn hóa đường dẫn ảnh sản phẩm tương tự order.controller và product.controller
function formatProductImageUrl(image) {
  const img = cleanText(image);
  if (!img) return "";
  if (/^https?:\/\//i.test(img) || img.startsWith("/") || img.startsWith("data:image/")) {
    return img;
  }
  if (/^(public\/)?assets\//i.test(img)) {
    return `/${img.replace(/^public\//i, "")}`;
  }
  if (/^(uploads|static)\//i.test(img)) {
    return `/${img}`;
  }
  return `/assets/images/${img.replace(/^\.\//, "")}`;
}

// Chuẩn hóa tên lý do đổi trả hiển thị đồng bộ với Figma
function normalizeDisplayReason(rawReason) {
  const r = String(rawReason || "").toLowerCase();
  if (r.includes("nhu cầu") || r.includes("changed_mind")) return "Đổi nhu cầu";
  if (r.includes("lỗi") || r.includes("damaged") || r.includes("hư") || r.includes("không hoạt động")) return "Lỗi sản phẩm";
  if (r.includes("phụ kiện") || r.includes("missing")) return "Thiếu phụ kiện";
  if (r.includes("không đúng") || r.includes("sai") || r.includes("wrong")) return "Giao sai hàng";
  if (r.includes("quá hạn") || r.includes("expired")) return "Quá hạn đổi trả";
  if (r.includes("giả") || r.includes("counterfeit")) return "Hàng giả, nhái";
  if (r.includes("khác với mô tả")) return "Khác với mô tả";
  return rawReason || "Lý do khác";
}

function normalizeStatus(status) {
  const s = cleanText(status).toLowerCase();
  if (["chờ xử lý", "cho xu ly", "pending"].includes(s)) return "pending";
  if (["đã duyệt", "da duyet", "approved"].includes(s)) return "approved";
  if (["đã hoàn tất", "da hoan tat", "hoàn tất", "completed", "refunded"].includes(s)) return "completed";
  if (["từ chối", "tu choi", "rejected"].includes(s)) return "rejected";
  return s;
}

// Hàm chuẩn hóa Timeline 5 bước phục vụ hiển thị Figma
function generateDefaultTimeline(returnOrder, order, staffName = "Nguyễn Minh Anh") {
  const createdAt = returnOrder.Created_at ? new Date(returnOrder.Created_at) : new Date();
  const timeline = [];

  // Bước 1: Khách hàng gửi yêu cầu (Luôn hoàn thành)
  timeline.push({
    Step: "request",
    Title: "Khách hàng gửi yêu cầu",
    Description: `${returnOrder.Return_name || "Khách hàng"} gửi yêu cầu hoàn trả`,
    Actor_id: order?.User_id || "",
    Actor_name: returnOrder.Return_name || "Khách hàng",
    Actor_role: "Customer",
    Status: "completed",
    Created_at: createdAt,
  });

  // Bước 2: Hệ thống kiểm tra điều kiện (Hệ thống đã auto-check đạt điều kiện lúc gửi)
  const checkTime = new Date(createdAt.getTime() + 5 * 60 * 1000);
  timeline.push({
    Step: "check_policy",
    Title: "Hệ thống kiểm tra điều kiện",
    Description: "Đủ điều kiện: trong thời hạn đổi trả theo chính sách · Đơn hàng đã giao",
    Actor_id: "system",
    Actor_name: "Hệ thống",
    Actor_role: "System",
    Status: "completed",
    Created_at: checkTime,
  });

  // Bước 3: Staff duyệt / từ chối
  if (["approved", "completed", "refunded"].includes(returnOrder.Status)) {
    const approvedAt = returnOrder.Handled_at || new Date(createdAt.getTime() + 2 * 3600 * 1000);
    timeline.push({
      Step: "review",
      Title: "Staff xác nhận duyệt yêu cầu",
      Description: `${returnOrder.Handled_by_name || staffName} - Đã xác nhận duyệt`,
      Actor_id: returnOrder.Handled_by || "",
      Actor_name: returnOrder.Handled_by_name || staffName,
      Actor_role: "Staff",
      Status: "completed",
      Created_at: approvedAt,
    });
  } else if (returnOrder.Status === "rejected" && !returnOrder.Inspected_at) {
    // Bị từ chối ngay ở bước xét duyệt hồ sơ
    const rejectedAt = returnOrder.Handled_at || new Date(createdAt.getTime() + 2 * 3600 * 1000);
    timeline.push({
      Step: "review",
      Title: "Staff từ chối yêu cầu",
      Description: returnOrder.Reject_reason || "Yêu cầu không đủ điều kiện",
      Actor_id: returnOrder.Handled_by || "",
      Actor_name: returnOrder.Handled_by_name || staffName,
      Actor_role: "Staff",
      Status: "rejected",
      Created_at: rejectedAt,
    });
  } else if (returnOrder.Status === "rejected" && returnOrder.Inspected_at) {
    // Đã được duyệt ở bước này, nhưng sau đó bị từ chối ở bước kiểm tra hàng
    const approvedAt = returnOrder.Handled_at || new Date(createdAt.getTime() + 2 * 3600 * 1000);
    timeline.push({
      Step: "review",
      Title: "Staff xác nhận duyệt yêu cầu",
      Description: `${returnOrder.Handled_by_name || staffName} - Đã xác nhận duyệt`,
      Actor_id: returnOrder.Handled_by || "",
      Actor_name: returnOrder.Handled_by_name || staffName,
      Actor_role: "Staff",
      Status: "completed",
      Created_at: approvedAt,
    });
  } else {
    // Đang chờ duyệt (pending)
    timeline.push({
      Step: "review",
      Title: "Staff duyệt / từ chối",
      Description: "Chờ Staff rà soát · Xác nhận trước khi duyệt hoặc từ chối",
      Actor_id: "",
      Actor_name: "",
      Actor_role: "Staff",
      Status: "waiting",
      Created_at: null,
    });
  }

  // Bước 4: Staff tiếp nhận và kiểm tra hàng hoàn trả
  if (["completed", "refunded"].includes(returnOrder.Status)) {
    const inspectedAt = returnOrder.Inspected_at || returnOrder.Handled_at || new Date(createdAt.getTime() + 24 * 3600 * 1000);
    timeline.push({
      Step: "inspect",
      Title: "Staff xác nhận hàng đạt",
      Description: `${returnOrder.Inspected_by_name || returnOrder.Handled_by_name || staffName} - Hàng đủ điều kiện hoàn trả`,
      Actor_id: returnOrder.Inspected_by || "",
      Actor_name: returnOrder.Inspected_by_name || returnOrder.Handled_by_name || staffName,
      Actor_role: "Staff",
      Status: "completed",
      Created_at: inspectedAt,
    });
  } else if (returnOrder.Status === "rejected" && returnOrder.Inspected_at) {
    // Bị từ chối hoàn tiền khi hàng không đạt điều kiện
    timeline.push({
      Step: "inspect",
      Title: "Staff từ chối hoàn tiền",
      Description: `${returnOrder.Inspected_by_name || staffName} - ${returnOrder.Reject_reason || "Hàng không đạt điều kiện hoàn trả"}`,
      Actor_id: returnOrder.Inspected_by || "",
      Actor_name: returnOrder.Inspected_by_name || staffName,
      Actor_role: "Staff",
      Status: "rejected",
      Created_at: returnOrder.Inspected_at,
    });
  } else if (returnOrder.Status === "approved") {
    // Đã duyệt, đang chờ khách gửi hàng về kho
    timeline.push({
      Step: "inspect",
      Title: "Staff tiếp nhận và kiểm tra hàng hoàn trả",
      Description: "Đang chờ khách gửi hàng về",
      Actor_id: "",
      Actor_name: "",
      Actor_role: "Staff",
      Status: "waiting",
      Created_at: null,
    });
  } else {
    // Chưa duyệt xong hoặc bị từ chối ở bước 3
    timeline.push({
      Step: "inspect",
      Title: "Staff tiếp nhận và kiểm tra hàng hoàn trả",
      Description: "Chờ khách gửi hàng về sau khi yêu cầu được duyệt",
      Actor_id: "",
      Actor_name: "",
      Actor_role: "Staff",
      Status: "waiting",
      Created_at: null,
    });
  }

  // Bước 5: Hệ thống cộng tồn kho và ghi nhận hoàn tiền
  if (["completed", "refunded"].includes(returnOrder.Status)) {
    const completedAt = returnOrder.Inspected_at || returnOrder.Handled_at || new Date(createdAt.getTime() + 24 * 3600 * 1000);
    timeline.push({
      Step: "completed",
      Title: "Hệ thống cộng tồn kho và ghi nhận hoàn tiền",
      Description: `Tồn kho +${returnOrder.Return_quantity || 1} · Hoàn tiền ${(returnOrder.Refund_amount || 0).toLocaleString("vi-VN")} đ`,
      Actor_id: "system",
      Actor_name: "Hệ thống",
      Actor_role: "System",
      Status: "completed",
      Created_at: completedAt,
    });
  } else if (returnOrder.Status === "rejected") {
    const rejectedAt = returnOrder.Inspected_at || returnOrder.Handled_at || new Date(createdAt.getTime() + 2 * 3600 * 1000);
    timeline.push({
      Step: "completed",
      Title: "Hệ thống gửi thông báo từ chối cho khách hàng",
      Description: "Đã gửi thông báo từ chối cho khách hàng",
      Actor_id: "system",
      Actor_name: "Hệ thống",
      Actor_role: "System",
      Status: "completed",
      Created_at: rejectedAt,
    });
  } else {
    timeline.push({
      Step: "completed",
      Title: "Hệ thống cộng tồn kho và ghi nhận hoàn tiền",
      Description: "Thực hiện sau khi Staff xác nhận hàng đạt",
      Actor_id: "system",
      Actor_name: "Hệ thống",
      Actor_role: "System",
      Status: "waiting",
      Created_at: null,
    });
  }

  return timeline;
}

// 1. Lấy danh sách yêu cầu đổi trả (Search + Filter + Pagination)
const getReturns = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const search = cleanText(req.query.search);
    const statusQuery = cleanText(req.query.status);
    const reasonQuery = cleanText(req.query.reason);
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;

    const query = {};

    // Lọc theo trạng thái
    if (statusQuery && statusQuery !== "all" && statusQuery !== "Tất cả trạng thái") {
      const norm = normalizeStatus(statusQuery);
      if (norm === "completed") {
        query.Status = { $in: ["completed", "refunded"] };
      } else {
        query.Status = norm;
      }
    }

    // Lọc theo lý do đổi trả (hỗ trợ cả tiếng Việt và mã code nội bộ)
    if (reasonQuery && reasonQuery !== "all" && reasonQuery !== "Tất cả lý do") {
      const r = reasonQuery.trim().toLowerCase();
      if (r.includes("nhu cầu") || r === "changed_mind") {
        query.Reason_type = /nhu cầu|changed_mind|đổi ý/i;
      } else if (r.includes("lỗi") || r.includes("hỏng") || r === "damaged") {
        query.Reason_type = /lỗi|hư|hỏng|damaged|không hoạt động/i;
      } else if (r.includes("phụ kiện") || r === "missing_accessories") {
        query.Reason_type = /phụ kiện|missing_accessories/i;
      } else if (r.includes("sai") || r === "wrong_item") {
        query.Reason_type = /sai|không đúng|wrong_item/i;
      } else if (r.includes("quá hạn") || r === "expired") {
        query.Reason_type = /quá hạn|expired/i;
      } else if (r.includes("khác")) {
        query.Reason_type = /khác|counterfeit|giả|không ổn/i;
      } else {
        query.Reason_type = new RegExp(reasonQuery, "i");
      }
    }

    // Lọc theo ngày
    if (startDate || endDate) {
      query.Created_at = {};
      if (startDate) query.Created_at.$gte = new Date(startDate);
      if (endDate) {
        const eDate = new Date(endDate);
        eDate.setHours(23, 59, 59, 999);
        query.Created_at.$lte = eDate;
      }
    }

    // Tìm kiếm (dùng escapeRegex tương tự product.controller và order.controller)
    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { Return_order_id: regex },
        { Order_id: regex },
        { Return_name: regex },
        { Return_phone: regex },
      ];
    }

    // Chạy song song count và query danh sách (áp dụng cấu trúc select tóm tắt như order.controller và index _id: -1 như product.controller để tối ưu tốc độ < 100ms)
    const [total, returns] = await Promise.all([
      Return_order.countDocuments(query),
      Return_order.find(query)
        .select(RETURN_SUMMARY_FIELDS)
        .sort({ Created_at: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    // Lấy thông tin biến thể sản phẩm và đơn hàng liên quan (chỉ select trường cần thiết)
    const variantIds = [...new Set(returns.map((r) => r.Product_variant_id).filter(Boolean))];
    const orderIds = [...new Set(returns.map((r) => r.Order_id).filter(Boolean))];

    const [variants, orders] = await Promise.all([
      variantIds.length > 0
        ? Product_variant.find({ Product_variant_id: { $in: variantIds } })
            .select("Product_variant_id Product_id Variant_name SKU Price")
            .lean()
        : [],
      orderIds.length > 0
        ? Order.find({ Order_id: { $in: orderIds } })
            .select("Order_id Receiver_name")
            .lean()
        : [],
    ]);

    const productIds = [...new Set(variants.map((v) => v.Product_id).filter(Boolean))];
    const products = productIds.length > 0
      ? await Product.find({ Product_id: { $in: productIds } })
          .select("Product_id Product_name Images")
          .lean()
      : [];

    const variantMap = new Map(variants.map((v) => [v.Product_variant_id, v]));
    const productMap = new Map(products.map((p) => [p.Product_id, p]));
    const orderMap = new Map(orders.map((o) => [o.Order_id, o]));

    // Gắn thông tin hiển thị
    const enrichedReturns = returns.map((item) => {
      const order = orderMap.get(item.Order_id);
      const variant = variantMap.get(item.Product_variant_id);
      const product = variant ? productMap.get(variant.Product_id) : null;

      const productName = product ? product.Product_name : (variant ? variant.Variant_name : "Sản phẩm đổi trả");
      const rawProductImage = (product?.Images && product.Images.length > 0) ? product.Images[0] : "";
      const productImage = formatProductImageUrl(rawProductImage);
      const customerName = item.Return_name || order?.Receiver_name || "Khách hàng";

      return {
        ...item,
        Reason_type: normalizeDisplayReason(item.Reason_type),
        Raw_reason_type: item.Reason_type,
        Customer_name: customerName,
        Product_name: productName,
        Product_image: productImage,
        Variant_name: variant ? variant.Variant_name : "",
        SKU: variant?.SKU || variant?.Product_variant_id || "",
        Status: item.Status === "refunded" ? "completed" : item.Status,
      };
    });

    return res.json({
      success: true,
      data: enrichedReturns,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("Error in getReturns:", err);
    return res.status(500).json({ success: false, message: "Lỗi tải danh sách yêu cầu đổi trả." });
  }
};

// 2. Lấy chi tiết một yêu cầu đổi trả
const getReturnDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const returnOrder = await Return_order.findOne({
      $or: [{ Return_order_id: id }, { _id: id.match(/^[0-9a-fA-F]{24}$/) ? id : null }],
    }).lean();

    if (!returnOrder) {
      return res.status(404).json({ success: false, message: "Không tìm thấy yêu cầu đổi trả." });
    }

    const [order, variant, orderDetails] = await Promise.all([
      Order.findOne({ Order_id: returnOrder.Order_id }).lean(),
      Product_variant.findOne({ Product_variant_id: returnOrder.Product_variant_id }).lean(),
      Order_detail.find({ Order_id: returnOrder.Order_id }).lean(),
    ]);

    const product = variant ? await Product.findOne({ Product_id: variant.Product_id }).lean() : null;

    // Tìm dòng order detail tương ứng
    const matchDetail = orderDetails.find((d) => d.Product_variant_id === returnOrder.Product_variant_id);
    const boughtQuantity = matchDetail ? matchDetail.Quantity : (returnOrder.Return_quantity || 1);

    const productName = product ? product.Product_name : (variant ? variant.Variant_name : "Sản phẩm đổi trả");
    const rawProductImage = (product?.Images && product.Images.length > 0) ? product.Images[0] : (returnOrder.Evidence_images?.[0] || "");
    const productImage = formatProductImageUrl(rawProductImage);
    const customerName = returnOrder.Return_name || order?.Receiver_name || "Khách hàng";
    const customerPhone = returnOrder.Return_phone || order?.Receiver_phone || "";
    const customerEmail = returnOrder.Return_email || order?.Email || "";
    const customerAddress = returnOrder.Return_address || order?.Specific_address || order?.Address || "";

    // Luôn sinh timeline 5 bước chuẩn hóa theo tiến trình thực tế của đơn hàng
    const timeline = generateDefaultTimeline(returnOrder, order, req.user?.Full_name);

    return res.json({
      success: true,
      data: {
        ...returnOrder,
        Reason_type: normalizeDisplayReason(returnOrder.Reason_type),
        Raw_reason_type: returnOrder.Reason_type,
        Status: returnOrder.Status === "refunded" ? "completed" : returnOrder.Status,
        Customer: {
          Name: customerName,
          Phone: customerPhone,
          Email: customerEmail,
          Address: customerAddress,
        },
        Order_info: {
          Order_id: order?.Order_id || returnOrder.Order_id,
          Created_at: order?.Created_at,
          Status: order?.Status || "delivered",
          Total_amount: order?.Total_amount || returnOrder.Refund_amount,
          Total_items: orderDetails.length,
        },
        Product_info: {
          Product_id: product?.Product_id || "",
          Product_name: productName,
          Product_image: productImage,
          Variant_id: variant?.Product_variant_id || returnOrder.Product_variant_id,
          Variant_name: variant?.Variant_name || "",
          SKU: variant?.SKU || variant?.Product_variant_id || "",
          Bought_quantity: boughtQuantity,
          Return_quantity: returnOrder.Return_quantity || 1,
          Price: variant?.Price || matchDetail?.Price || 0,
          Refund_amount: returnOrder.Refund_amount || 0,
        },
        Timeline: timeline,
      },
    });
  } catch (err) {
    console.error("Error in getReturnDetail:", err);
    return res.status(500).json({ success: false, message: "Lỗi tải chi tiết yêu cầu đổi trả." });
  }
};

// 3. Staff duyệt yêu cầu đổi trả (Giai đoạn 1)
const approveReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const returnOrder = await Return_order.findOne({ Return_order_id: id });

    if (!returnOrder) {
      return res.status(404).json({ success: false, message: "Không tìm thấy yêu cầu đổi trả." });
    }

    if (returnOrder.Status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Yêu cầu đang ở trạng thái '${returnOrder.Status}', không thể duyệt.`,
      });
    }

    const staffId = req.user?.User_id || "STAFF_01";
    const staffName = req.user?.Full_name || req.user?.Username || "Nguyễn Minh Anh";
    const now = new Date();

    returnOrder.Status = "approved";
    returnOrder.Handled_by = staffId;
    returnOrder.Handled_by_name = staffName;
    returnOrder.Handled_at = now;

    // Cập nhật timeline
    const order = await Order.findOne({ Order_id: returnOrder.Order_id }).lean();
    returnOrder.Timeline = generateDefaultTimeline(returnOrder, order, staffName);

    await returnOrder.save();

    // BUG-03: Ghi nhận sự kiện duyệt yêu cầu đổi trả vào lịch sử đơn hàng gốc
    await Order.updateOne(
      { Order_id: returnOrder.Order_id },
      {
        $push: {
          Status_history: buildHistoryEntry({
            fromStatus: order?.Status || 'returning',
            toStatus: order?.Status || 'returning',
            event: ORDER_EVENTS.RETURN_APPROVED,
            actor: { id: staffId, name: staffName },
            note: `Duyệt yêu cầu đổi trả mã ${returnOrder.Return_order_id}`
          })
        }
      }
    ).catch((err) => console.error("Error updating order history on approve:", err.message));

    // Gửi thông báo cho khách hàng
    if (order?.User_id) {
      await createNotification({
        audience: "customer",
        userId: order.User_id,
        type: "hoàn trả hàng",
        title: "Yêu cầu đổi trả đã được phê duyệt",
        message: `Yêu cầu đổi trả mã ${returnOrder.Return_order_id} cho đơn hàng ${returnOrder.Order_id} đã được duyệt. Vui lòng gửi hàng về kho theo hướng dẫn.`,
        orderId: returnOrder.Order_id,
      }).catch((e) => console.error("Error creating notif:", e.message));
    }

    return res.json({
      success: true,
      message: "Phê duyệt yêu cầu đổi trả thành công. Đã gửi hướng dẫn gửi hàng cho khách.",
      data: returnOrder,
    });
  } catch (err) {
    console.error("Error in approveReturn:", err);
    return res.status(500).json({ success: false, message: "Lỗi phê duyệt yêu cầu đổi trả." });
  }
};


// BUG-03 HELPER: Khôi phục trạng thái đơn hàng gốc khi yêu cầu đổi trả bị từ chối
async function handleOrderStateOnReturnRejection(orderId, rejectedReturnId, staffId, staffName, rejectReason, eventType) {
  try {
    const otherActiveReturns = await Return_order.find({
      Order_id: orderId,
      Return_order_id: { $ne: rejectedReturnId },
      Status: { $in: ["pending", "approved"] },
    }).lean();

    if (otherActiveReturns.length > 0) {
      // Vẫn còn yêu cầu đổi trả khác đang chờ xử lý -> Order giữ nguyên trạng thái 'returning'
      await Order.updateOne(
        { Order_id: orderId },
        {
          $push: {
            Status_history: buildHistoryEntry({
              fromStatus: "returning",
              toStatus: "returning",
              event: eventType,
              actor: { id: staffId, name: staffName },
              note: `Từ chối yêu cầu đổi trả ${rejectedReturnId}: ${rejectReason}`,
            }),
          },
        }
      );
      return;
    }

    // Không còn yêu cầu nào đang active. Kiểm tra xem có yêu cầu nào đã thành công (completed/refunded) không.
    const completedReturns = await Return_order.find({
      Order_id: orderId,
      Return_order_id: { $ne: rejectedReturnId },
      Status: { $in: ["completed", "refunded"] },
    }).lean();

    if (completedReturns.length > 0) {
      // Đã có món hàng khác được hoàn trả thành công -> Order vẫn mang tính chất hoàn hàng
      await Order.updateOne(
        { Order_id: orderId },
        {
          $push: {
            Status_history: buildHistoryEntry({
              fromStatus: "returning",
              toStatus: "returning",
              event: eventType,
              actor: { id: staffId, name: staffName },
              note: `Từ chối yêu cầu đổi trả ${rejectedReturnId}: ${rejectReason}`,
            }),
          },
        }
      );
      return;
    }

    // Toàn bộ các yêu cầu đổi trả của đơn hàng này đều bị từ chối! Khôi phục lại trạng thái trước khi returning.
    const order = await Order.findOne({ Order_id: orderId }).select("Status Status_history").lean();
    let restoreStatus = "delivered";
    if (Array.isArray(order?.Status_history)) {
      for (let i = order.Status_history.length - 1; i >= 0; i--) {
        const h = order.Status_history[i];
        if (h.Event === ORDER_EVENTS.RETURN_REQUESTED && h.From_status) {
          restoreStatus = h.From_status;
          break;
        }
      }
    }

    await Order.updateOne(
      { Order_id: orderId },
      {
        $set: { Status: restoreStatus },
        $push: {
          Status_history: buildHistoryEntry({
            fromStatus: order?.Status || "returning",
            toStatus: restoreStatus,
            event: eventType,
            actor: { id: staffId, name: staffName },
            note: `Tất cả yêu cầu đổi trả bị từ chối · Khôi phục trạng thái đơn hàng về '${restoreStatus}' · Lý do: ${rejectReason}`,
          }),
        },
      }
    );
  } catch (err) {
    console.error("Error in handleOrderStateOnReturnRejection:", err.message);
  }
}

// 4. Staff từ chối yêu cầu đổi trả ban đầu (Giai đoạn 1)
const rejectReturn = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectReason } = req.body;

    if (!cleanText(rejectReason)) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập lý do từ chối yêu cầu đổi trả.",
      });
    }

    const returnOrder = await Return_order.findOne({ Return_order_id: id });

    if (!returnOrder) {
      return res.status(404).json({ success: false, message: "Không tìm thấy yêu cầu đổi trả." });
    }

    if (returnOrder.Status !== "pending") {
      return res.status(400).json({
        success: false,
        message: `Yêu cầu đang ở trạng thái '${returnOrder.Status}', không thể từ chối duyệt.`,
      });
    }

    const staffId = req.user?.User_id || "STAFF_01";
    const staffName = req.user?.Full_name || req.user?.Username || "Nguyễn Minh Anh";
    const now = new Date();

    returnOrder.Status = "rejected";
    returnOrder.Handled_by = staffId;
    returnOrder.Handled_by_name = staffName;
    returnOrder.Handled_at = now;
    returnOrder.Reject_reason = cleanText(rejectReason);

    const order = await Order.findOne({ Order_id: returnOrder.Order_id }).lean();
    returnOrder.Timeline = generateDefaultTimeline(returnOrder, order, staffName);

    await returnOrder.save();

    // BUG-03: Đồng bộ trạng thái đơn hàng gốc khi từ chối duyệt yêu cầu
    await handleOrderStateOnReturnRejection(
      returnOrder.Order_id,
      returnOrder.Return_order_id,
      staffId,
      staffName,
      cleanText(rejectReason),
      ORDER_EVENTS.RETURN_REJECTED
    );

    // Gửi thông báo cho khách hàng
    if (order?.User_id) {
      await createNotification({
        audience: "customer",
        userId: order.User_id,
        type: "hoàn trả hàng",
        title: "Yêu cầu đổi trả bị từ chối",
        message: `Yêu cầu đổi trả mã ${returnOrder.Return_order_id} đã bị từ chối với lý do: ${rejectReason}`,
        orderId: returnOrder.Order_id,
      }).catch((e) => console.error("Error creating notif:", e.message));
    }

    return res.json({
      success: true,
      message: "Đã từ chối yêu cầu đổi trả thành công.",
      data: returnOrder,
    });
  } catch (err) {
    console.error("Error in rejectReturn:", err);
    return res.status(500).json({ success: false, message: "Lỗi từ chối yêu cầu đổi trả." });
  }
};

// 5. Staff xác nhận hàng hoàn trả đạt điều kiện (Giai đoạn 2: Tiếp nhận hàng & hoàn tiền)
const acceptGoods = async (req, res) => {
  try {
    const { id } = req.params;
    const returnOrder = await Return_order.findOne({ Return_order_id: id });

    if (!returnOrder) {
      return res.status(404).json({ success: false, message: "Không tìm thấy yêu cầu đổi trả." });
    }

    if (returnOrder.Status !== "approved") {
      return res.status(400).json({
        success: false,
        message: `Chỉ có thể xác nhận hàng khi yêu cầu ở trạng thái 'Đã duyệt' (approved). Hiện tại: '${returnOrder.Status}'.`,
      });
    }

    const staffId = req.user?.User_id || "STAFF_01";
    const staffName = req.user?.Full_name || req.user?.Username || "Nguyễn Minh Anh";
    const now = new Date();
    const returnQty = Math.max(1, Number(returnOrder.Return_quantity) || 1);

    // 1. Tự động cộng tồn kho vào Product_variant
    if (returnOrder.Product_variant_id) {
      await Product_variant.updateOne(
        { Product_variant_id: returnOrder.Product_variant_id },
        { $inc: { Stock_quantity: returnQty } }
      );
    }

    // 2. Ghi nhận hoàn tiền & hoàn tất
    returnOrder.Status = "completed";
    returnOrder.Inspected_by = staffId;
    returnOrder.Inspected_by_name = staffName;
    returnOrder.Inspected_at = now;
    returnOrder.Inspected_result = "accepted";

    const order = await Order.findOne({ Order_id: returnOrder.Order_id }).lean();
    returnOrder.Timeline = generateDefaultTimeline(returnOrder, order, staffName);

    await returnOrder.save();

    // BUG-02 FIX: Chỉ điều chỉnh Total_spent của khách hàng khi Staff xác nhận hàng đạt tại kho
    const refundAmount = Number(returnOrder.Refund_amount) || 0;
    if (order?.User_id && refundAmount > 0) {
      await User.updateOne(
        { User_id: order.User_id },
        { $inc: { Total_spent: -refundAmount } }
      );
      await User.updateOne(
        { User_id: order.User_id, Total_spent: { $lt: 0 } },
        { $set: { Total_spent: 0 } }
      );
    }

    // BUG-03 FIX: Ghi nhận sự kiện hoàn tất đổi trả vào lịch sử đơn hàng gốc
    await Order.updateOne(
      { Order_id: returnOrder.Order_id },
      {
        $push: {
          Status_history: buildHistoryEntry({
            fromStatus: order?.Status || "returning",
            toStatus: order?.Status || "returning",
            event: ORDER_EVENTS.RETURN_COMPLETED,
            actor: { id: staffId, name: staffName },
            note: `Xác nhận hàng hoàn đạt mã ${returnOrder.Return_order_id} · Tồn kho +${returnQty} · Số tiền hoàn ${refundAmount.toLocaleString("vi-VN")} đ`,
          }),
        },
      }
    ).catch((err) => console.error("Error logging return completed history:", err.message));

    // BUG-04 FIX: Cập nhật Payment_status thành 'refunded' khi toàn bộ đơn hàng được hoàn trả
    try {
      const otherCompletedReturns = await Return_order.find({
        Order_id: returnOrder.Order_id,
        Return_order_id: { $ne: returnOrder.Return_order_id },
        Status: { $in: ["completed", "refunded"] },
      }).lean();
      const totalRefunded = otherCompletedReturns.reduce(
        (sum, r) => sum + (Number(r.Refund_amount) || 0),
        refundAmount
      );
      const orderTotal = Number(order?.Total_amount) || 0;
      if (totalRefunded >= orderTotal && orderTotal > 0) {
        await Payment.updateOne(
          { Order_id: returnOrder.Order_id, Payment_status: "paid" },
          { $set: { Payment_status: "refunded" } }
        );
      }
    } catch (pErr) {
      console.error("Error updating payment on acceptGoods:", pErr.message);
    }

    // 3. Gửi thông báo cho khách hàng
    if (order?.User_id) {
      await createNotification({
        audience: "customer",
        userId: order.User_id,
        type: "hoàn trả hàng",
        title: "Đổi trả hoàn tất & Đã ghi nhận hoàn tiền",
        message: `Sản phẩm hoàn trả mã ${returnOrder.Return_order_id} đã được kiểm tra đạt yêu cầu. Số tiền ${(returnOrder.Refund_amount || 0).toLocaleString("vi-VN")} đ đã được ghi nhận hoàn trả.`,
        orderId: returnOrder.Order_id,
      }).catch((e) => console.error("Error creating notif:", e.message));
    }

    return res.json({
      success: true,
      message: `Đã xác nhận hàng đạt thành công! Tồn kho đã được cộng lại (+${returnQty}) và hoàn tiền đã ghi nhận.`,
      data: returnOrder,
    });
  } catch (err) {
    console.error("Error in acceptGoods:", err);
    return res.status(500).json({ success: false, message: "Lỗi xác nhận hàng đạt." });
  }
};

// 6. Staff từ chối hoàn tiền khi hàng không đạt điều kiện (Giai đoạn 2)
const rejectGoods = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectReason } = req.body;

    if (!cleanText(rejectReason)) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập lý do hàng hoàn trả không đạt điều kiện.",
      });
    }

    const returnOrder = await Return_order.findOne({ Return_order_id: id });

    if (!returnOrder) {
      return res.status(404).json({ success: false, message: "Không tìm thấy yêu cầu đổi trả." });
    }

    if (returnOrder.Status !== "approved") {
      return res.status(400).json({
        success: false,
        message: `Chỉ có thể từ chối hoàn tiền khi yêu cầu ở trạng thái 'Đã duyệt' (approved). Hiện tại: '${returnOrder.Status}'.`,
      });
    }

    const staffId = req.user?.User_id || "STAFF_01";
    const staffName = req.user?.Full_name || req.user?.Username || "Nguyễn Minh Anh";
    const now = new Date();

    returnOrder.Status = "rejected";
    returnOrder.Inspected_by = staffId;
    returnOrder.Inspected_by_name = staffName;
    returnOrder.Inspected_at = now;
    returnOrder.Inspected_result = "rejected";
    returnOrder.Reject_reason = cleanText(rejectReason);

    const order = await Order.findOne({ Order_id: returnOrder.Order_id }).lean();
    returnOrder.Timeline = generateDefaultTimeline(returnOrder, order, staffName);

    await returnOrder.save();

    // BUG-03: Đồng bộ trạng thái đơn hàng gốc khi từ chối nhận hàng hoàn
    await handleOrderStateOnReturnRejection(
      returnOrder.Order_id,
      returnOrder.Return_order_id,
      staffId,
      staffName,
      cleanText(rejectReason),
      ORDER_EVENTS.RETURN_GOODS_REJECTED
    );

    // Gửi thông báo cho khách hàng
    if (order?.User_id) {
      await createNotification({
        audience: "customer",
        userId: order.User_id,
        type: "hoàn trả hàng",
        title: "Từ chối hoàn tiền sản phẩm",
        message: `Sản phẩm hoàn trả mã ${returnOrder.Return_order_id} không đạt điều kiện hoàn tiền: ${rejectReason}`,
        orderId: returnOrder.Order_id,
      }).catch((e) => console.error("Error creating notif:", e.message));
    }

    return res.json({
      success: true,
      message: "Đã từ chối hoàn tiền thành công. Tồn kho không thay đổi.",
      data: returnOrder,
    });
  } catch (err) {
    console.error("Error in rejectGoods:", err);
    return res.status(500).json({ success: false, message: "Lỗi từ chối hoàn tiền." });
  }
};

module.exports = {
  getReturns,
  getReturnDetail,
  approveReturn,
  rejectReturn,
  acceptGoods,
  rejectGoods,
};

