const { User, Address, Order, Order_detail, Return_order, Review } = require("../../models/schema");

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const VALID_STATUSES = ["active", "blocked"];

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * GET /api/admin/customers
 * Danh sách khách hàng kèm tìm kiếm, lọc trạng thái, phân trang và thống kê
 * Quyền: Manager, Staff (chỉ xem các tài khoản có Role = "Customer")
 */

function toCustomerDto(user) {
  if (!user) return null;
  return {
    User_id: user.User_id,
    Username: user.Username,
    Full_name: user.Full_name || "",
    Email: user.Email,
    Phone_number: user.Phone_number || "",
    Status: user.Status,
    Created_at: user.Created_at,
  };
}

exports.getCustomers = async (req, res) => {
  try {
    const keyword = cleanText(req.query.keyword);
    const status = cleanText(req.query.status);
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(
      parsePositiveInt(req.query.limit, DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE
    );

    // BẮT BUỘC: Giới hạn chỉ lấy khách hàng có Role = "Customer"
    const filter = { Role: "Customer" };

    if (VALID_STATUSES.includes(status)) {
      filter.Status = status;
    }

    if (keyword) {
      const pattern = new RegExp(escapeRegex(keyword), "i");
      filter.$or = [
        { User_id: pattern },
        { Username: pattern },
        { Full_name: pattern },
        { Email: pattern },
        { Phone_number: pattern },
      ];
    }

    const [items, totalFiltered, statsResult] = await Promise.all([
      User.find(filter)
        .select("User_id Username Full_name Email Phone_number Status Created_at")
        .sort({ Created_at: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
      User.aggregate([
        { $match: { Role: "Customer" } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: {
              $sum: { $cond: [{ $eq: ["$Status", "active"] }, 1, 0] },
            },
            blocked: {
              $sum: { $cond: [{ $eq: ["$Status", "blocked"] }, 1, 0] },
            },
          },
        },
      ]),
    ]);

    const statsGroup = statsResult[0] || {};
    const stats = {
      total: statsGroup.total || 0,
      active: statsGroup.active || 0,
      blocked: statsGroup.blocked || 0,
    };

    const userIds = items.map((user) => user.User_id);
    const customerMetrics = new Map();

    if (userIds.length > 0) {
      const orderAgg = await Order.aggregate([
        { $match: { User_id: { $in: userIds } } },
        {
          $group: {
            _id: "$User_id",
            orderCount: { $sum: 1 },
            totalSpent: {
              $sum: {
                $cond: [
                  { $in: ["$Status", ["delivered", "review"]] },
                  { $ifNull: ["$Total_amount", 0] },
                  0,
                ],
              },
            },
          },
        },
      ]);

      for (const m of orderAgg) {
        customerMetrics.set(m._id, {
          orderCount: m.orderCount || 0,
          totalSpent: m.totalSpent || 0,
        });
      }
    }

    const totalPages = Math.ceil(totalFiltered / limit) || 0;

    const customerItems = items.map((user) => {
      const metrics = customerMetrics.get(user.User_id) || { orderCount: 0, totalSpent: 0 };
      return {
        User_id: user.User_id,
        Username: user.Username,
        Full_name: user.Full_name || "",
        Email: user.Email,
        Phone_number: user.Phone_number || "",
        Status: user.Status,
        Created_at: user.Created_at,
        order_count: metrics.orderCount,
        total_spent: metrics.totalSpent,
      };
    });

    return res.json({
      success: true,
      items: customerItems,
      total: totalFiltered,
      page,
      limit,
      totalPages,
      stats,
      data: {
        items: customerItems,
        total: totalFiltered,
        page,
        limit,
        totalPages,
        stats,
      },
    });
  } catch (error) {
    console.error("getCustomers error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách khách hàng",
    });
  }
};

/**
 * GET /api/admin/customers/:id
 * Chi tiết khách hàng (hồ sơ, địa chỉ, thống kê đơn hàng và tổng chi tiêu thực tế)
 * Quyền: Manager, Staff
 * Lưu ý: :id là User_id. Nếu :id thuộc Manager hoặc Staff -> trả 404 Not Found.
 */
exports.getCustomerById = async (req, res) => {
  try {
    const userId = cleanText(req.params.id);
    if (!userId) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    // 1. Chỉ tìm tài khoản khách hàng Role = "Customer"
    const customer = await User.findOne({
      User_id: userId,
      Role: "Customer",
    })
      .select("User_id Username Full_name Email Phone_number Status Created_at")
      .lean();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    // 2. Lấy danh sách địa chỉ của khách hàng
    const addresses = await Address.find({ User_id: customer.User_id })
      .select(
        "Address_id Receiver_name Receiver_phone Email Province District Ward Specific_address Is_default"
      )
      .sort({ Is_default: -1, _id: 1 })
      .lean();

    // 3. Thống kê đơn hàng và tính tổng chi tiêu thực tế (orderStats & totalSpent)
    // Lấy toàn bộ đơn hàng của khách
    const orders = await Order.find({ User_id: customer.User_id })
      .select("Order_id Total_amount Status")
      .lean();

    let total = orders.length;
    let completedCount = 0;
    let processingCount = 0;
    let cancelledCount = 0;
    let totalSpent = 0;

    if (total > 0) {
      // Thu thập Order_id của các đơn có thể có liên quan đến đổi trả
      const relevantOrderIds = orders
        .filter((o) => ["delivered", "review", "returning"].includes(o.Status))
        .map((o) => o.Order_id);

      let returnOrders = [];
      if (relevantOrderIds.length > 0) {
        returnOrders = await Return_order.find({
          Order_id: { $in: relevantOrderIds },
        })
          .select("Return_order_id Order_id Refund_amount Status")
          .lean();
      }

      // Gom nhóm Return_order theo Order_id
      const returnsByOrderId = new Map();
      for (const ret of returnOrders) {
        if (!returnsByOrderId.has(ret.Order_id)) {
          returnsByOrderId.set(ret.Order_id, []);
        }
        returnsByOrderId.get(ret.Order_id).push(ret);
      }

      for (const order of orders) {
        const status = order.Status;
        const orderAmount = Number(order.Total_amount) || 0;
        const orderReturns = returnsByOrderId.get(order.Order_id) || [];

        // Nhóm đơn đã hủy
        if (status === "cancelled") {
          cancelledCount++;
          // Đơn hủy không đóng góp vào totalSpent
          continue;
        }

        // Trường hợp A: Đơn hoàn tất thông thường (delivered hoặc review)
        if (status === "delivered" || status === "review") {
          const validReturns = orderReturns.filter((r) =>
            ["completed", "refunded"].includes(r.Status)
          );
          const totalRefund = validReturns.reduce(
            (sum, r) => sum + (Number(r.Refund_amount) || 0),
            0
          );
          const retainedAmount = Math.max(0, orderAmount - totalRefund);

          totalSpent += retainedAmount;
          completedCount++;
          continue;
        }

        // Trường hợp B: Đơn có trạng thái returning (liên quan đến đổi trả hàng)
        if (status === "returning") {
          // B1: Nếu đơn không có bản ghi Return_order nào (dữ liệu mồ côi / không nhất quán)
          if (orderReturns.length === 0) {
            processingCount++;
            continue;
          }

          // B2: Nếu còn bất kỳ Return_order nào đang pending hoặc approved
          // Đơn vẫn đang trong quá trình đổi trả -> tạm thời không tính totalSpent, phân loại processing
          const hasActiveReturns = orderReturns.some((r) =>
            ["pending", "approved"].includes(r.Status)
          );

          if (hasActiveReturns) {
            processingCount++;
            continue;
          }

          // B3: Toàn bộ yêu cầu đổi trả đã kết thúc (tất cả đều là completed, refunded hoặc rejected)
          const validReturns = orderReturns.filter((r) =>
            ["completed", "refunded"].includes(r.Status)
          );
          const totalRefund = validReturns.reduce(
            (sum, r) => sum + (Number(r.Refund_amount) || 0),
            0
          );

          // Phần giá trị khách giữ lại (nếu tất cả rejected thì totalRefund = 0 -> retainedAmount = orderAmount)
          const retainedAmount = Math.max(0, orderAmount - totalRefund);

          if (retainedAmount > 0) {
            // Có giữ lại hàng: tính phần giữ lại vào totalSpent và phân loại completed
            totalSpent += retainedAmount;
            completedCount++;
          } else {
            // Đã hoàn tiền 100% (không giữ lại hàng): không đóng góp chi tiêu, phân loại processing (hậu mãi)
            processingCount++;
          }
          continue;
        }

        // Các trạng thái đang xử lý khác: pending_payment, processing, shipping
        processingCount++;
      }
    }

    const orderStats = {
      total,
      completed: completedCount,
      processing: processingCount,
      cancelled: cancelledCount,
      totalSpent,
    };

    const customerOrderIds = orders.map((o) => o.Order_id);

    // 4. Lấy danh sách đơn hàng chi tiết, lịch sử đánh giá và đổi trả
    const [detailedOrders, customerReviews, customerReturns] = await Promise.all([
      customerOrderIds.length > 0
        ? Order.aggregate([
            { $match: { User_id: customer.User_id } },
            { $sort: { Created_at: -1 } },
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
              $lookup: {
                from: "Order_detail",
                localField: "Order_id",
                foreignField: "Order_id",
                as: "Items",
              },
            },
            {
              $project: {
                Order_id: 1,
                Total_amount: 1,
                Status: 1,
                Created_at: 1,
                Payment_type: { $ifNull: ["$PaymentInfo.Payment_type", "COD"] },
                Payment_status: { $ifNull: ["$PaymentInfo.Payment_status", "pending"] },
                item_count: { $size: "$Items" },
              },
            },
          ])
        : [],
      customerOrderIds.length > 0
        ? Review.aggregate([
            {
              $lookup: {
                from: "Order_detail",
                localField: "Order_detail_id",
                foreignField: "Order_detail_id",
                as: "Detail",
              },
            },
            { $unwind: "$Detail" },
            { $match: { "Detail.Order_id": { $in: customerOrderIds } } },
            {
              $lookup: {
                from: "Product_variant",
                localField: "Detail.Product_variant_id",
                foreignField: "Product_variant_id",
                as: "Variant",
              },
            },
            { $unwind: { path: "$Variant", preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from: "Product",
                localField: "Variant.Product_id",
                foreignField: "Product_id",
                as: "Product",
              },
            },
            { $unwind: { path: "$Product", preserveNullAndEmptyArrays: true } },
            { $sort: { Created_at: -1 } },
            {
              $project: {
                Review_id: 1,
                Order_id: "$Detail.Order_id",
                Product_name: { $ifNull: ["$Product.Product_name", "$Detail.Variant_name"] },
                Variant_name: "$Detail.Variant_name",
                Product_image: {
                  $cond: [
                    { $gt: [{ $size: { $ifNull: ["$Product.Images", []] } }, 0] },
                    { $concat: ["/assets/images/", { $arrayElemAt: ["$Product.Images", 0] }] },
                    "",
                  ],
                },
                Rating: 1,
                Comment: 1,
                Images: 1,
                Moderation_status: 1,
                Reply_content: 1,
                Replied_at: 1,
                Created_at: 1,
              },
            },
          ])
        : [],
      customerOrderIds.length > 0
        ? Return_order.aggregate([
            { $match: { Order_id: { $in: customerOrderIds } } },
            {
              $lookup: {
                from: "Product_variant",
                localField: "Product_variant_id",
                foreignField: "Product_variant_id",
                as: "Variant",
              },
            },
            { $unwind: { path: "$Variant", preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from: "Product",
                localField: "Variant.Product_id",
                foreignField: "Product_id",
                as: "Product",
              },
            },
            { $unwind: { path: "$Product", preserveNullAndEmptyArrays: true } },
            { $sort: { Created_at: -1 } },
            {
              $project: {
                Return_order_id: 1,
                Order_id: 1,
                Product_name: { $ifNull: ["$Product.Product_name", "$Variant.Variant_name"] },
                Variant_name: "$Variant.Variant_name",
                Product_image: {
                  $cond: [
                    { $gt: [{ $size: { $ifNull: ["$Product.Images", []] } }, 0] },
                    { $concat: ["/assets/images/", { $arrayElemAt: ["$Product.Images", 0] }] },
                    "",
                  ],
                },
                Return_quantity: 1,
                Reason_type: 1,
                Reason_codes: 1,
                Description: 1,
                Evidence_images: 1,
                Refund_amount: 1,
                Status: 1,
                Created_at: 1,
              },
            },
          ])
        : [],
    ]);

    return res.json({
      success: true,
      customer: {
        User_id: customer.User_id,
        Username: customer.Username,
        Full_name: customer.Full_name || "",
        Email: customer.Email,
        Phone_number: customer.Phone_number || "",
        Status: customer.Status,
        Created_at: customer.Created_at,
      },
      addresses: addresses.map((addr) => ({
        Address_id: addr.Address_id,
        Receiver_name: addr.Receiver_name || "",
        Receiver_phone: addr.Receiver_phone || "",
        Email: addr.Email || "",
        Province: addr.Province || "",
        District: addr.District || "",
        Ward: addr.Ward || "",
        Specific_address: addr.Specific_address || "",
        Is_default: Boolean(addr.Is_default),
      })),
      orderStats,
      orders: detailedOrders,
      reviews: customerReviews,
      returns: customerReturns,
    });
  } catch (error) {
    console.error("getCustomerById error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy thông tin chi tiết khách hàng",
    });
  }
};

/**
 * PATCH /api/admin/customers/:id/lock
 * Khóa tài khoản khách hàng
 * Quyền: Chỉ Manager
 * Điều kiện: Chỉ thao tác trên tài khoản có Role = "Customer"
 */
exports.lockCustomer = async (req, res) => {
  try {
    const userId = cleanText(req.params.id);
    if (!userId) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    // 1. Chỉ tìm tài khoản có Role = "Customer" (không tiết lộ Manager/Staff)
    const customer = await User.findOne({
      User_id: userId,
      Role: "Customer",
    })
      .select("User_id Username Full_name Email Phone_number Status Created_at")
      .lean();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    // 2. Nếu đã ở trạng thái blocked: không cập nhật dư thừa
    if (customer.Status === "blocked") {
      return res.json({
        success: true,
        message: "Tài khoản đã ở trạng thái bị khóa",
        customer: toCustomerDto(customer),
      });
    }

    // 3. Cập nhật Status = "blocked" nguyên tử
    const updated = await User.findOneAndUpdate(
      { User_id: customer.User_id, Role: "Customer" },
      { $set: { Status: "blocked" } },
      { new: true }
    )
      .select("User_id Username Full_name Email Phone_number Status Created_at")
      .lean();

    return res.json({
      success: true,
      message: "Khóa tài khoản khách hàng thành công",
      customer: toCustomerDto(updated),
    });
  } catch (error) {
    console.error("lockCustomer error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Không thể khóa tài khoản khách hàng",
    });
  }
};

/**
 * PATCH /api/admin/customers/:id/unlock
 * Mở khóa tài khoản khách hàng
 * Quyền: Chỉ Manager
 * Điều kiện: Chỉ thao tác trên tài khoản có Role = "Customer"
 */
exports.unlockCustomer = async (req, res) => {
  try {
    const userId = cleanText(req.params.id);
    if (!userId) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    // 1. Chỉ tìm tài khoản có Role = "Customer" (không tiết lộ Manager/Staff)
    const customer = await User.findOne({
      User_id: userId,
      Role: "Customer",
    })
      .select("User_id Username Full_name Email Phone_number Status Created_at")
      .lean();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy khách hàng",
      });
    }

    // 2. Nếu đã ở trạng thái active: không cập nhật dư thừa
    if (customer.Status === "active") {
      return res.json({
        success: true,
        message: "Tài khoản đã ở trạng thái hoạt động",
        customer: toCustomerDto(customer),
      });
    }

    // 3. Cập nhật Status = "active", xóa bộ đếm đăng nhập sai Failed_Login_Count và Locked_Until
    const updated = await User.findOneAndUpdate(
      { User_id: customer.User_id, Role: "Customer" },
      {
        $set: {
          Status: "active",
          Failed_Login_Count: 0,
          Locked_Until: null,
        },
      },
      { new: true }
    )
      .select("User_id Username Full_name Email Phone_number Status Created_at")
      .lean();

    return res.json({
      success: true,
      message: "Mở khóa tài khoản khách hàng thành công",
      customer: toCustomerDto(updated),
    });
  } catch (error) {
    console.error("unlockCustomer error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Không thể mở khóa tài khoản khách hàng",
    });
  }
};
