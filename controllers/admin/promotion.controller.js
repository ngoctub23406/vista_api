const { Voucher, Order } = require("../../models/schema");
const {
  VOUCHER_COUNTED_ORDER_STATUSES,
  parseVoucherDateTime,
  formatDateToVNISO,
  extractLegacyDiscountInfo,
  resolvePromotionStatus,
} = require("../../services/promotion-helper");

function cleanString(value) {
  return String(value || "").trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTypeForClient(type) {
  const t = cleanString(type).toLowerCase();
  if (t === "shipping" || t === "freeship") return "free_shipping";
  if (t === "fixed" || t === "fixed_amount") return "fixed_amount";
  return t;
}

function normalizeTypeForDb(type) {
  const t = cleanString(type).toLowerCase();
  if (t === "free_shipping") return "shipping";
  if (t === "fixed") return "fixed_amount";
  return t;
}

// Chuyển Date sang định dạng legacy DD/MM/YYYY
function formatToLegacyDMY(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  // Điều chỉnh timezone +07:00
  const vnTime = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const day = String(vnTime.getUTCDate()).padStart(2, "0");
  const month = String(vnTime.getUTCMonth() + 1).padStart(2, "0");
  const year = vnTime.getUTCFullYear();
  return `${day}/${month}/${year}`;
}

// Lấy danh sách chương trình khuyến mãi (Manager & Staff)
exports.getPromotions = async (req, res) => {
  try {
    const keyword = cleanString(req.query.keyword || req.query.search);
    const statusFilter = cleanString(req.query.status);
    const type = cleanString(req.query.type);
    const dateFilter = cleanString(req.query.dateFilter);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const filter = {};

    if (keyword) {
      const regex = new RegExp(escapeRegExp(keyword), "i");
      filter.$or = [{ code: regex }, { title: regex }, { description: regex }];
    }

    if (type && type !== "all") {
      filter.type = normalizeTypeForDb(type);
    }

    // Truy vấn tất cả vouchers để thống kê KPI thời gian thực và phân trang
    const [allVouchers, vouchers, totalVouchersCount] = await Promise.all([
      Voucher.find({}).lean(),
      Voucher.find(filter).sort({ createdAt: -1 }).lean(),
      Voucher.countDocuments(filter),
    ]);

    // Lấy số lượng đơn hàng thực tế
    const voucherCodes = vouchers.map((v) => v.code);
    const usageCounts = await Order.aggregate([
      {
        $match: {
          $or: [{ Voucher_code: { $in: voucherCodes } }, { Voucher_id: { $in: voucherCodes } }],
          Status: { $in: VOUCHER_COUNTED_ORDER_STATUSES },
        },
      },
      {
        $group: {
          _id: { $ifNull: ["$Voucher_code", "$Voucher_id"] },
          count: { $sum: 1 },
        },
      },
    ]);
    const countMap = new Map(usageCounts.map((u) => [u._id, u.count]));

    // Đánh giá trạng thái hiệu lực cho toàn bộ vouchers để tính KPI chính xác
    const now = new Date();
    const stats = {
      total: allVouchers.length,
      active: 0,
      upcoming: 0,
      paused: 0,
      draft: 0,
      expired: 0,
    };

    allVouchers.forEach((v) => {
      const used = v.used_count || 0;
      const resolved = resolvePromotionStatus(v, used, now);
      if (resolved.status === "active") stats.active++;
      else if (resolved.status === "upcoming") stats.upcoming++;
      else if (resolved.status === "paused") stats.paused++;
      else if (resolved.status === "draft") stats.draft++;
      else if (resolved.status === "expired" || resolved.status === "out_of_quota") stats.expired++;
    });

    // Chuẩn hóa danh sách items kèm fallback bóc tách dữ liệu cũ
    let transformedItems = vouchers.map((v) => {
      const legacy = extractLegacyDiscountInfo(v);
      const usedCount = countMap.get(v.code) ?? v.used_count ?? 0;
      const resolved = resolvePromotionStatus(v, usedCount, now);

      const parsedStart = parseVoucherDateTime(v.startDate, false);
      const parsedEnd = parseVoucherDateTime(v.endDate || v.expiry, true);

      return {
        id: v._id.toString(),
        code: v.code,
        title: v.title,
        description: v.description || "",
        type: normalizeTypeForClient(legacy.normalizedType || v.type),
        discountValue: legacy.discountValue,
        maxDiscountAmount: legacy.maxDiscountAmount,
        minOrderValue: legacy.minOrderValue,
        usageLimit: v.usage_limit || 0,
        usedCount,
        usageLimitPerCustomer: v.usage_limit_per_customer || 1,
        scope: v.scope || "all_products",
        applicableCategories: v.applicable_categories || [],
        startDate: parsedStart ? formatDateToVNISO(parsedStart) : "",
        endDate: parsedEnd ? formatDateToVNISO(parsedEnd) : "",
        status: resolved.status,
        statusLabel: resolved.statusLabel,
        warning: legacy.warning || "",
        createdAt: v.createdAt ? new Date(v.createdAt).toISOString() : new Date().toISOString(),
        createdBy: v.created_by || "Admin",
      };
    });

    // Lọc theo trạng thái hiệu lực nếu client yêu cầu (active, upcoming, paused, draft, expired, out_of_quota)
    if (statusFilter && statusFilter !== "all") {
      transformedItems = transformedItems.filter((item) => {
        if (statusFilter === "expired") {
          return item.status === "expired" || item.status === "out_of_quota";
        }
        return item.status === statusFilter;
      });
    }

    if (dateFilter === "today") {
      transformedItems = transformedItems.filter((item) => item.status === "active");
    } else if (dateFilter === "7days") {
      transformedItems = transformedItems.filter(
        (item) => item.status === "active" || item.status === "upcoming"
      );
    } else if (dateFilter === "30days") {
      transformedItems = transformedItems.filter((item) => {
        const endDate = parseVoucherDateTime(item.endDate, true);
        return endDate && endDate >= now;
      });
    }

    const total = transformedItems.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const paginatedItems = transformedItems.slice((page - 1) * limit, page * limit);

    return res.json({
      success: true,
      data: {
        items: paginatedItems,
        total,
        page,
        limit,
        totalPages,
        stats,
      },
    });
  } catch (error) {
    console.error("Lỗi getPromotions:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tải danh sách khuyến mãi.",
    });
  }
};

// Xem chi tiết khuyến mãi (Manager & Staff)
exports.getPromotionById = async (req, res) => {
  try {
    const id = cleanString(req.params.id);
    let voucher = null;

    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      voucher = await Voucher.findById(id).lean();
    }
    if (!voucher) {
      voucher = await Voucher.findOne({ code: new RegExp(`^${escapeRegExp(id)}$`, "i") }).lean();
    }

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy chương trình khuyến mãi.",
      });
    }

    // Đếm số đơn hàng hợp lệ
    const [orderUsedCount, orderSummary] = await Promise.all([
      Order.countDocuments({
        $or: [{ Voucher_id: voucher.code }, { Voucher_code: voucher.code }],
        Status: { $in: VOUCHER_COUNTED_ORDER_STATUSES },
      }),
      Order.aggregate([
        {
          $match: {
            $or: [{ Voucher_id: voucher.code }, { Voucher_code: voucher.code }],
            Status: { $in: VOUCHER_COUNTED_ORDER_STATUSES },
          },
        },
        {
          $group: {
            _id: null,
            totalDiscountGiven: { $sum: "$Voucher_discount_amount" },
            totalShippingDiscountGiven: { $sum: "$Voucher_shipping_discount" },
          },
        },
      ]),
    ]);
    const usedCount = orderUsedCount || voucher.used_count || 0;

    const totalDiscountAmount =
      (orderSummary[0]?.totalDiscountGiven || 0) +
      (orderSummary[0]?.totalShippingDiscountGiven || 0);

    const legacy = extractLegacyDiscountInfo(voucher);
    const resolved = resolvePromotionStatus(voucher, usedCount, new Date());
    const parsedStart = parseVoucherDateTime(voucher.startDate, false);
    const parsedEnd = parseVoucherDateTime(voucher.endDate || voucher.expiry, true);

    return res.json({
      success: true,
      data: {
        id: voucher._id.toString(),
        code: voucher.code,
        title: voucher.title,
        description: voucher.description || "",
        type: normalizeTypeForClient(legacy.normalizedType || voucher.type),
        discountValue: legacy.discountValue,
        maxDiscountAmount: legacy.maxDiscountAmount,
        minOrderValue: legacy.minOrderValue,
        usageLimit: voucher.usage_limit || 0,
        usedCount,
        usageLimitPerCustomer: voucher.usage_limit_per_customer || 1,
        scope: voucher.scope || "all_products",
        applicableCategories: voucher.applicable_categories || [],
        startDate: parsedStart ? formatDateToVNISO(parsedStart) : "",
        endDate: parsedEnd ? formatDateToVNISO(parsedEnd) : "",
        status: resolved.status,
        statusLabel: resolved.statusLabel,
        warning: legacy.warning || "",
        createdAt: voucher.createdAt ? new Date(voucher.createdAt).toISOString() : new Date().toISOString(),
        createdBy: voucher.created_by || "Admin",
        analytics: {
          totalDiscountAmount,
        },
      },
    });
  } catch (error) {
    console.error("Lỗi getPromotionById:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tải chi tiết khuyến mãi.",
    });
  }
};

// Tạo chương trình khuyến mãi mới (Chỉ Manager)
exports.createPromotion = async (req, res) => {
  try {
    const body = req.body || {};
    const code = cleanString(body.code).toUpperCase();
    const title = cleanString(body.title);
    const rawType = cleanString(body.type);
    const dbType = normalizeTypeForDb(rawType);
    const discountValue = Number(body.discountValue);
    const maxDiscountAmount = Number(body.maxDiscountAmount) || 0;
    const minOrderValue = Number(body.minOrderValue) || 0;
    const usageLimit = Number(body.usageLimit) || 0;
    const usageLimitPerCustomer = Number(body.usageLimitPerCustomer) || 1;
    const scope = body.scope === "specific_categories" ? "specific_categories" : "all_products";
    const applicableCategories = Array.isArray(body.applicableCategories) ? body.applicableCategories : [];
    const status = cleanString(body.status) || "active";

    // Validations
    if (!code) {
      return res.status(400).json({ success: false, message: "Mã khuyến mãi là bắt buộc." });
    }
    if (!/^[A-Z0-9_-]{3,20}$/.test(code)) {
      return res.status(400).json({
        success: false,
        message: "Mã khuyến mãi phải từ 3-20 ký tự (chữ hoa, số, gạch nối).",
      });
    }
    if (!title) {
      return res.status(400).json({ success: false, message: "Tên chương trình là bắt buộc." });
    }
    if (!["percent", "shipping", "fixed_amount"].includes(dbType)) {
      return res.status(400).json({ success: false, message: "Loại ưu đãi không hợp lệ." });
    }
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      return res.status(400).json({ success: false, message: "Mức giảm giá phải lớn hơn 0." });
    }
    if (dbType === "percent" && discountValue > 100) {
      return res.status(400).json({ success: false, message: "Mức giảm theo phần trăm không được vượt quá 100%." });
    }
    if (minOrderValue < 0) {
      return res.status(400).json({ success: false, message: "Giá trị đơn hàng tối thiểu không được âm." });
    }

    const startDateParsed = parseVoucherDateTime(body.startDate, false);
    const endDateParsed = parseVoucherDateTime(body.endDate || body.expiry, true);

    if (!endDateParsed) {
      return res.status(400).json({ success: false, message: "Ngày kết thúc là bắt buộc và hợp lệ." });
    }
    if (startDateParsed && endDateParsed < startDateParsed) {
      return res.status(400).json({ success: false, message: "Ngày kết thúc phải sau hoặc bằng ngày bắt đầu." });
    }
    if (scope === "specific_categories" && applicableCategories.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng chọn ít nhất một danh mục áp dụng.",
      });
    }

    // Kiểm tra trùng mã code
    const existing = await Voucher.findOne({
      code: new RegExp(`^${escapeRegExp(code)}$`, "i"),
    }).lean();

    if (existing) {
      return res.status(400).json({
        success: false,
        message: `Mã khuyến mãi "${code}" đã tồn tại trên hệ thống.`,
      });
    }

    const category = dbType === "shipping" ? "freeship" : "discount";
    const condition = minOrderValue > 0
      ? `Đơn hàng từ ${minOrderValue.toLocaleString("vi-VN")}đ`
      : "Cho mọi đơn hàng hợp lệ";

    const creatorName = req.user?.Full_name || req.user?.Username || "Manager";

    const newVoucher = await Voucher.create({
      code,
      title,
      description: cleanString(body.description),
      condition,
      type: dbType,
      category,
      status: ["draft", "paused"].includes(status) ? status : "active",
      expiry: formatToLegacyDMY(endDateParsed),
      startDate: formatToLegacyDMY(startDateParsed),
      minOrderValue,
      maxDiscountAmount: dbType === "percent" ? maxDiscountAmount : 0,
      discountValue,
      scope,
      applicable_categories: applicableCategories,
      usage_limit: usageLimit,
      usage_limit_per_customer: usageLimitPerCustomer,
      used_count: 0,
      used_user_ids: [],
      created_by: creatorName,
      benefits: [
        dbType === "percent"
          ? `Giảm ${discountValue}% giá trị đơn hàng.`
          : dbType === "shipping"
          ? `Giảm tối đa ${discountValue.toLocaleString("vi-VN")}đ phí vận chuyển.`
          : `Giảm trực tiếp ${discountValue.toLocaleString("vi-VN")}đ.`,
      ],
      conditions: [
        condition,
        scope === "specific_categories"
          ? `Áp dụng cho danh mục: ${applicableCategories.join(", ")}.`
          : "Áp dụng cho tất cả sản phẩm trên hệ thống.",
      ],
    });

    return res.status(201).json({
      success: true,
      message: "Tạo chương trình khuyến mãi thành công.",
      data: {
        id: newVoucher._id.toString(),
        code: newVoucher.code,
        title: newVoucher.title,
        status: newVoucher.status,
      },
    });
  } catch (error) {
    console.error("Lỗi createPromotion:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tạo chương trình khuyến mãi.",
    });
  }
};

// Cập nhật chương trình khuyến mãi (Chỉ Manager)
exports.updatePromotion = async (req, res) => {
  try {
    const id = cleanString(req.params.id);
    let voucher = null;

    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      voucher = await Voucher.findById(id);
    }
    if (!voucher) {
      voucher = await Voucher.findOne({ code: new RegExp(`^${escapeRegExp(id)}$`, "i") });
    }

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy chương trình khuyến mãi.",
      });
    }

    // Kiểm tra xem chương trình đã có đơn hàng sử dụng hay chưa
    const hasOrders = await Order.exists({
      $or: [{ Voucher_id: voucher.code }, { Voucher_code: voucher.code }],
      Status: { $in: VOUCHER_COUNTED_ORDER_STATUSES },
    });

    const body = req.body || {};
    const title = cleanString(body.title) || voucher.title;
    const description = cleanString(body.description) || voucher.description;
    const rawType = cleanString(body.type);
    const dbType = rawType ? normalizeTypeForDb(rawType) : voucher.type;
    const discountValue = body.discountValue !== undefined ? Number(body.discountValue) : voucher.discountValue;
    const maxDiscountAmount = body.maxDiscountAmount !== undefined ? Number(body.maxDiscountAmount) : voucher.maxDiscountAmount;
    const minOrderValue = body.minOrderValue !== undefined ? Number(body.minOrderValue) : voucher.minOrderValue;
    const usageLimit = body.usageLimit !== undefined ? Number(body.usageLimit) : voucher.usage_limit;
    const usageLimitPerCustomer = body.usageLimitPerCustomer !== undefined ? Number(body.usageLimitPerCustomer) : voucher.usage_limit_per_customer;
    const scope = body.scope || voucher.scope || "all_products";
    const applicableCategories = Array.isArray(body.applicableCategories) ? body.applicableCategories : voucher.applicable_categories;
    const status = cleanString(body.status) || voucher.status;

    // Không được đổi mã code nếu đã phát sinh đơn hàng
    if (body.code && cleanString(body.code).toUpperCase() !== voucher.code) {
      if (hasOrders) {
        return res.status(400).json({
          success: false,
          message: "Không thể đổi mã khuyến mãi khi đã có đơn hàng sử dụng mã này.",
        });
      }
      const newCode = cleanString(body.code).toUpperCase();
      const codeConflict = await Voucher.findOne({
        _id: { $ne: voucher._id },
        code: new RegExp(`^${escapeRegExp(newCode)}$`, "i"),
      }).lean();
      if (codeConflict) {
        return res.status(400).json({
          success: false,
          message: `Mã "${newCode}" đã được sử dụng bởi chương trình khác.`,
        });
      }
      voucher.code = newCode;
    }

    // Không được đổi loại ưu đãi nếu đã phát sinh đơn hàng
    if (hasOrders && dbType !== voucher.type) {
      return res.status(400).json({
        success: false,
        message: "Không thể thay đổi loại ưu đãi của chương trình đã phát sinh đơn hàng.",
      });
    }

    if (discountValue <= 0) {
      return res.status(400).json({ success: false, message: "Mức giảm giá phải lớn hơn 0." });
    }
    if (dbType === "percent" && discountValue > 100) {
      return res.status(400).json({ success: false, message: "Mức giảm theo % không được vượt quá 100%." });
    }

    const startDateParsed = body.startDate ? parseVoucherDateTime(body.startDate, false) : parseVoucherDateTime(voucher.startDate, false);
    const endDateParsed = (body.endDate || body.expiry) ? parseVoucherDateTime(body.endDate || body.expiry, true) : parseVoucherDateTime(voucher.endDate || voucher.expiry, true);

    if (startDateParsed && endDateParsed && endDateParsed < startDateParsed) {
      return res.status(400).json({ success: false, message: "Ngày kết thúc phải sau hoặc bằng ngày bắt đầu." });
    }

    voucher.title = title;
    voucher.description = description;
    voucher.type = dbType;
    voucher.category = dbType === "shipping" ? "freeship" : "discount";
    voucher.discountValue = discountValue;
    voucher.maxDiscountAmount = dbType === "percent" ? maxDiscountAmount : 0;
    voucher.minOrderValue = minOrderValue;
    voucher.usage_limit = usageLimit;
    voucher.usage_limit_per_customer = usageLimitPerCustomer;
    voucher.scope = scope;
    voucher.applicable_categories = applicableCategories;
    if (startDateParsed) voucher.startDate = formatToLegacyDMY(startDateParsed);
    if (endDateParsed) voucher.expiry = formatToLegacyDMY(endDateParsed);
    if (["draft", "paused", "active"].includes(status)) voucher.status = status;
    voucher.condition = minOrderValue > 0
      ? `Đơn hàng từ ${minOrderValue.toLocaleString("vi-VN")}đ`
      : "Cho mọi đơn hàng hợp lệ";

    await voucher.save();

    return res.json({
      success: true,
      message: "Cập nhật chương trình khuyến mãi thành công.",
      data: {
        id: voucher._id.toString(),
        code: voucher.code,
        title: voucher.title,
        status: voucher.status,
      },
    });
  } catch (error) {
    console.error("Lỗi updatePromotion:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật chương trình khuyến mãi.",
    });
  }
};

// Đổi trạng thái Kích hoạt / Tạm ngừng (Chỉ Manager)
exports.changePromotionStatus = async (req, res) => {
  try {
    const id = cleanString(req.params.id);
    const newStatus = cleanString(req.body.status);

    if (!["active", "paused", "draft"].includes(newStatus)) {
      return res.status(400).json({
        success: false,
        message: "Trạng thái mới không hợp lệ (chỉ chấp nhận active, paused, draft).",
      });
    }

    let voucher = null;
    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      voucher = await Voucher.findById(id);
    }
    if (!voucher) {
      voucher = await Voucher.findOne({ code: new RegExp(`^${escapeRegExp(id)}$`, "i") });
    }

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy chương trình khuyến mãi.",
      });
    }

    voucher.status = newStatus;
    await voucher.save();

    return res.json({
      success: true,
      message: `Đã chuyển trạng thái chương trình "${voucher.code}" sang ${newStatus}.`,
      data: {
        id: voucher._id.toString(),
        code: voucher.code,
        status: voucher.status,
      },
    });
  } catch (error) {
    console.error("Lỗi changePromotionStatus:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể thay đổi trạng thái chương trình.",
    });
  }
};

// Xóa chương trình khuyến mãi (Chỉ Manager)
exports.deletePromotion = async (req, res) => {
  try {
    const id = cleanString(req.params.id);
    let voucher = null;

    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      voucher = await Voucher.findById(id);
    }
    if (!voucher) {
      voucher = await Voucher.findOne({ code: new RegExp(`^${escapeRegExp(id)}$`, "i") });
    }

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy chương trình khuyến mãi.",
      });
    }

    // KIỂM TRA TÍNH TOÀN VẸN: Không xóa nếu đã có đơn hàng sử dụng mã
    const hasOrders = await Order.exists({
      $or: [{ Voucher_id: voucher.code }, { Voucher_code: voucher.code }],
      Status: { $in: VOUCHER_COUNTED_ORDER_STATUSES },
    });

    if (hasOrders) {
      return res.status(400).json({
        success: false,
        message: "Không thể xóa chương trình khuyến mãi đã phát sinh đơn hàng. Bạn có thể tạm ngừng chương trình thay vì xóa.",
      });
    }

    await Voucher.deleteOne({ _id: voucher._id });

    return res.json({
      success: true,
      message: `Đã xóa chương trình khuyến mãi "${voucher.code}" thành công.`,
    });
  } catch (error) {
    console.error("Lỗi deletePromotion:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể xóa chương trình khuyến mãi.",
    });
  }
};
