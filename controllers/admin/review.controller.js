const { Review, User } = require("../../models/schema");
const { createNotification } = require("../../services/notification.service");
const {
  loadReviewContext,
  generateAndStoreAutoReply,
} = require("../../services/review-auto-reply.service");

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const REPLY_MIN_LENGTH = 10;
const REPLY_MAX_LENGTH = 1000;
const DISPLAY_STATUSES = ["pending", "approved", "replied", "rejected"];

function cleanText(value) {
  return String(value || "").trim();
}

function cleanMultiline(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lấy tên Staff để ghi vào lịch sử xử lý
async function getActor(req) {
  const user = await User.findOne({ User_id: req.user?.User_id })
    .select("Full_name Username Email")
    .lean();

  return {
    id: req.user?.User_id || "",
    name: user?.Full_name || user?.Username || req.user?.Email || "Staff",
  };
}

function normalizeImages(value) {
  if (Array.isArray(value)) return value.filter(Boolean);

  const raw = String(value || "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [raw];
  } catch {
    return [raw];
  }
}

function productImage(product) {
  return product?.Images?.length
    ? "/assets/images/" + product.Images[0]
    : "";
}

// Quy tắc nội dung phản hồi (UC-18, luồng 4a)
function validateReplyContent(content) {
  if (content.length < REPLY_MIN_LENGTH) {
    return `Nội dung phản hồi quá ngắn (tối thiểu ${REPLY_MIN_LENGTH} ký tự).`;
  }

  if (content.length > REPLY_MAX_LENGTH) {
    return `Nội dung phản hồi quá dài (tối đa ${REPLY_MAX_LENGTH} ký tự).`;
  }

  if (/(https?:\/\/|www\.|[\w.+-]+@[\w-]+\.[\w.-]+)/i.test(content)) {
    return "Phản hồi không được chứa đường dẫn hoặc địa chỉ email.";
  }

  return "";
}

// Trạng thái hiển thị: ánh xạ từ Moderation_status và Reply_status
function getDisplayStatus(review) {
  const moderation = review.Moderation_status || "pending";
  if (moderation === "rejected") return "rejected";
  if (review.Reply_status === "replied") return "replied";
  if (moderation === "approved") return "approved";
  return "pending";
}

function getAvailableActions(review) {
  const status = getDisplayStatus(review);
  if (status === "pending") return ["approve", "reject"];
  if (status === "approved") return ["suggest_reply", "save_draft", ...(review.Reply_reviewed && review.Reply_draft ? ["send_reply"] : [])];
  return [];
}

// Danh sách đánh giá (Staff, Manager): kèm số đếm từng trạng thái
exports.getReviews = async (req, res) => {
  try {
    const keyword = cleanText(req.query.keyword);
    const status = cleanText(req.query.status);
    const rating = Number(req.query.rating);
    const fromDate = cleanText(req.query.fromDate);
    const toDate = cleanText(req.query.toDate);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.limit) || DEFAULT_PAGE_SIZE));

    // Bộ lọc chung (áp dụng cho cả danh sách và số đếm trên các nhãn trạng thái)
    const filterMatch = {};
    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
      filterMatch.Rating = rating;
    }

    if (fromDate || toDate) {
      filterMatch.Created_at = {};
      if (fromDate) filterMatch.Created_at.$gte = new Date(`${fromDate}T00:00:00`);
      if (toDate) filterMatch.Created_at.$lte = new Date(`${toDate}T23:59:59.999`);
    }

    if (keyword) {
      const regex = new RegExp(escapeRegex(keyword), "i");
      filterMatch.$or = [
        { Review_id: regex },
        { Comment: regex },
        { "Order.Receiver_name": regex },
        { "Product.Product_name": regex },
        { "Variant.Variant_name": regex },
      ];
    }

    const statusMatch = DISPLAY_STATUSES.includes(status) ? { Display_status: status } : {};

    const lookup = (from, localField, foreignField, as) => [
      { $lookup: { from, localField, foreignField, as } },
      { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
    ];

    const [result] = await Review.aggregate([
      ...lookup("Order_detail", "Order_detail_id", "Order_detail_id", "Detail"),
      ...lookup("Order", "Detail.Order_id", "Order_id", "Order"),
      ...lookup("Product_variant", "Detail.Product_variant_id", "Product_variant_id", "Variant"),
      ...lookup("Product", "Variant.Product_id", "Product_id", "Product"),
      {
        $addFields: {
          Display_status: {
            $switch: {
              branches: [
                { case: { $eq: [{ $ifNull: ["$Moderation_status", "pending"] }, "rejected"] }, then: "rejected" },
                { case: { $eq: [{ $ifNull: ["$Reply_status", "no_auto_reply"] }, "replied"] }, then: "replied" },
                { case: { $eq: [{ $ifNull: ["$Moderation_status", "pending"] }, "approved"] }, then: "approved" },
              ],
              default: "pending",
            },
          },
        },
      },
      {
        $project: {
          Review_id: 1,
          Rating: 1,
          Comment: 1,
          Created_at: 1,
          Display_status: 1,
          Reply_draft: 1,
          Replied_at: 1,
          Image_count: {
            $cond: [
              { $isArray: "$Images" },
              { $size: "$Images" },
              { $cond: [{ $and: [{ $eq: [{ $type: "$Images" }, "string"] }, { $ne: ["$Images", ""] }] }, 1, 0] },
            ],
          },
          Product_image: {
            $cond: [{ $isArray: "$Product.Images" }, { $arrayElemAt: ["$Product.Images", 0] }, null],
          },
          "Order.Receiver_name": 1,
          "Product.Product_name": 1,
          "Variant.Variant_name": 1,
          "Variant.Product_variant_id": 1,
        },
      },
      { $match: filterMatch },
      {
        $facet: {
          counts: [{ $group: { _id: "$Display_status", count: { $sum: 1 } } }],
          drafts: [
            { $match: { Display_status: "approved", Reply_draft: { $nin: [null, ""] } } },
            { $count: "count" },
          ],
          total: [{ $match: statusMatch }, { $count: "count" }],
          items: [
            { $match: statusMatch },
            { $sort: { Created_at: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
          ],
        },
      },
    ]).option({ allowDiskUse: true });

    const counts = { all: 0, drafts: result?.drafts?.[0]?.count || 0 };
    DISPLAY_STATUSES.forEach((key) => {
      counts[key] = 0;
    });
    (result?.counts || []).forEach((item) => {
      counts[item._id] = item.count;
      counts.all += item.count;
    });

    const items = (result?.items || []).map((review) => ({
      Review_id: review.Review_id,
      Customer_name: review.Order?.Receiver_name || "",
      Product_name: review.Product?.Product_name || review.Variant?.Variant_name || "",
      Variant_name: review.Variant?.Variant_name || "",
      Product_variant_id: review.Variant?.Product_variant_id || "",
      Image: review.Product_image
        ? "/assets/images/" + review.Product_image
        : "",
      Rating: review.Rating,
      Comment: review.Comment || "",
      Image_count: review.Image_count || 0,
      Created_at: review.Created_at,
      Display_status: review.Display_status,
      Has_draft: Boolean(review.Reply_draft) && review.Display_status === "approved",
      Replied_at: review.Replied_at || null,
    }));

    return res.json({
      success: true,
      data: { items, total: result?.total?.[0]?.count || 0, page, limit, counts },
    });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách đánh giá:", error);
    return res.status(500).json({ success: false, message: "Không thể tải danh sách đánh giá" });
  }
};

async function buildReviewDetail(review) {
  const { detail, order, variant, product } = await loadReviewContext(review);

  const history = [
    {
      Event: "created",
      Actor_id: order?.User_id || "",
      Actor_name: "Khách hàng",
      Note: "Khách hàng gửi đánh giá",
      Created_at: review.Created_at,
    },
    ...(review.History || []),
  ];

  return {
    Review_id: review.Review_id,
    Created_at: review.Created_at,
    Rating: review.Rating,
    Comment: review.Comment || "",
    Images: normalizeImages(review.Images),
    Display_status: getDisplayStatus(review),
    Available_actions: getAvailableActions(review),

    Customer_name: order?.Receiver_name || "",
    Customer_phone: order?.Receiver_phone || "",
    Customer_email: order?.Email || "",
    Order_id: detail?.Order_id || "",
    Is_verified_purchase: Boolean(order),

    Product_id: product?.Product_id || "",
    Product_name: product?.Product_name || variant?.Variant_name || "",
    Variant_name: variant?.Variant_name || detail?.Variant_name || "",
    Product_variant_id: detail?.Product_variant_id || "",
    Image: productImage(product),

    Moderated_by_name: review.Moderated_by_name || "",
    Moderated_at: review.Moderated_at || null,
    Moderation_note: review.Moderation_note || "",

    AI_reply_draft: review.AI_reply_draft || "",
    Reply_draft: review.Reply_draft || "",
    Reply_draft_version: review.Reply_draft_version || 0,
    Reply_draft_by_name: review.Reply_draft_by_name || "",
    Reply_draft_at: review.Reply_draft_at || null,
    Reply_reviewed: Boolean(review.Reply_reviewed),
    Reply_content: review.Reply_content || "",
    Replied_by_name: review.Replied_by_name || "",
    Replied_at: review.Replied_at || null,

    History: history,
  };
}

// Chi tiết một đánh giá (Staff, Manager)
exports.getReviewDetail = async (req, res) => {
  try {
    const review = await Review.findOne({ Review_id: cleanText(req.params.reviewId) }).lean();
    if (!review) {
      return res.status(404).json({ success: false, message: "Không tìm thấy đánh giá" });
    }

    return res.json({ success: true, data: await buildReviewDetail(review) });
  } catch (error) {
    console.error("Lỗi khi lấy chi tiết đánh giá:", error);
    return res.status(500).json({ success: false, message: "Không thể tải chi tiết đánh giá" });
  }
};

async function conflictOrMissing(reviewId) {
  const exists = await Review.exists({ Review_id: reviewId });
  if (!exists) {
    return { status: 404, message: "Không tìm thấy đánh giá" };
  }

  return {
    status: 409,
    message: "Đánh giá đã được cập nhật bởi người khác. Vui lòng tải lại để xem trạng thái mới nhất.",
  };
}

// Staff duyệt hoặc từ chối đánh giá
exports.moderateReview = async (req, res) => {
  try {
    const reviewId = cleanText(req.params.reviewId);
    const decision = cleanText(req.body?.decision);
    const note = cleanMultiline(req.body?.note);

    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ success: false, message: "Thao tác không hợp lệ" });
    }

    if (decision === "reject" && note.length < 5) {
      return res.status(400).json({ success: false, message: "Vui lòng nhập lý do từ chối đánh giá" });
    }

    const actor = await getActor(req);
    const now = new Date();
    const approved = decision === "approve";

    const result = await Review.updateOne(
      {
        Review_id: reviewId,
        $or: [{ Moderation_status: "pending" }, { Moderation_status: { $exists: false } }],
        Reply_status: { $ne: "replied" },
      },
      {
        $set: {
          Moderation_status: approved ? "approved" : "rejected",
          Moderated_by: actor.id,
          Moderated_by_name: actor.name,
          Moderated_at: now,
          Moderation_note: note,
        },
        $push: {
          History: {
            Event: approved ? "approved" : "rejected",
            Actor_id: actor.id,
            Actor_name: actor.name,
            Note: approved ? "Staff duyệt đánh giá" : `Staff từ chối đánh giá: ${note}`,
            Created_at: now,
          },
        },
      }
    );

    if (result.modifiedCount === 0) {
      const failure = await conflictOrMissing(reviewId);
      return res.status(failure.status).json({ success: false, message: failure.message });
    }

    return res.json({
      success: true,
      message: approved ? "Đã duyệt đánh giá" : "Đã từ chối đánh giá",
    });
  } catch (error) {
    console.error("Lỗi khi kiểm duyệt đánh giá:", error);
    return res.status(500).json({ success: false, message: "Kiểm duyệt đánh giá thất bại, vui lòng thử lại" });
  }
};

// Staff bấm "Tạo gợi ý AI": sinh lại Auto-reply, chỉ lưu để tham khảo (không gửi cho khách)
exports.suggestReply = async (req, res) => {
  try {
    const reviewId = cleanText(req.params.reviewId);
    const review = await Review.findOne({ Review_id: reviewId })
      .select("Moderation_status Reply_status")
      .lean();

    if (!review) {
      return res.status(404).json({ success: false, message: "Không tìm thấy đánh giá" });
    }

    if (review.Moderation_status !== "approved" || review.Reply_status === "replied") {
      return res.status(409).json({
        success: false,
        message: "Chỉ tạo được gợi ý cho đánh giá đã duyệt và chưa phản hồi.",
      });
    }

    const actor = await getActor(req);

    try {
      const draft = await generateAndStoreAutoReply(reviewId, { id: actor.id, name: actor.name });
      return res.json({ success: true, message: "Đã tạo gợi ý phản hồi", data: { AI_reply_draft: draft } });
    } catch (error) {
      if (error.code === "ALREADY_REPLIED") {
        return res.status(409).json({ success: false, message: error.message });
      }

      console.error("Lỗi AI khi tạo gợi ý phản hồi:", error);
      return res.status(502).json({
        success: false,
        message: "AI chưa tạo được gợi ý. Bạn có thể thử lại hoặc tự soạn phản hồi.",
      });
    }
  } catch (error) {
    console.error("Lỗi khi tạo gợi ý phản hồi:", error);
    return res.status(500).json({ success: false, message: "Không thể tạo gợi ý, vui lòng thử lại" });
  }
};

// Staff "Lưu và rà soát": lưu bản nháp đã kiểm tra, chưa gửi cho khách
exports.saveDraft = async (req, res) => {
  try {
    const reviewId = cleanText(req.params.reviewId);
    const content = cleanMultiline(req.body?.content);

    const invalid = validateReplyContent(content);
    if (invalid) {
      return res.status(400).json({ success: false, message: invalid });
    }

    const review = await Review.findOne({ Review_id: reviewId })
      .select("Moderation_status Reply_status Reply_draft_version")
      .lean();

    if (!review) {
      return res.status(404).json({ success: false, message: "Không tìm thấy đánh giá" });
    }

    if (review.Moderation_status !== "approved" || review.Reply_status === "replied") {
      return res.status(409).json({
        success: false,
        message: "Chỉ lưu được phản hồi cho đánh giá đã duyệt và chưa phản hồi.",
      });
    }

    const actor = await getActor(req);
    const now = new Date();
    const version = (review.Reply_draft_version || 0) + 1;

    const result = await Review.updateOne(
      {
        Review_id: reviewId,
        Moderation_status: "approved",
        Reply_status: { $ne: "replied" },
        $or: [
          { Reply_draft_version: review.Reply_draft_version || 0 },
          { Reply_draft_version: { $exists: false } },
        ],
      },
      {
        $set: {
          Reply_draft: content,
          Reply_draft_version: version,
          Reply_draft_by_name: actor.name,
          Reply_draft_at: now,
          Reply_reviewed: true,
        },
        $push: {
          History: {
            Event: "draft_saved",
            Actor_id: actor.id,
            Actor_name: actor.name,
            Note: `Staff chỉnh sửa và rà soát phản hồi v${version} · Chưa gửi`,
            Created_at: now,
          },
        },
      }
    );

    if (result.modifiedCount === 0) {
      const failure = await conflictOrMissing(reviewId);
      return res.status(failure.status).json({ success: false, message: failure.message });
    }

    return res.json({ success: true, message: "Đã lưu và rà soát phản hồi", data: { Reply_draft_version: version } });
  } catch (error) {
    console.error("Lỗi khi lưu bản nháp phản hồi:", error);
    return res.status(500).json({ success: false, message: "Lưu phản hồi thất bại, vui lòng thử lại" });
  }
};

// Thông báo cho khách khi cửa hàng phản hồi. Lỗi thông báo không làm hỏng việc gửi phản hồi.
async function notifyCustomerOfReply(review) {
  try {
    const { detail, order, product } = await loadReviewContext(review);
    if (!order?.User_id) return;

    await createNotification({
      audience: "customer",
      userId: order.User_id,
      type: "review_replied",
      title: "Cửa hàng đã phản hồi đánh giá của bạn",
      message: `VISTA đã phản hồi đánh giá của bạn về ${product?.Product_name || "sản phẩm"}.`,
      orderId: detail?.Order_id || "",
      link: product?.Product_id ? `/products/${product.Product_id}` : "/order-history",
    });
  } catch (error) {
    console.error("Lỗi gửi thông báo phản hồi đánh giá:", error);
  }
}

// Staff gửi phản hồi cuối cùng (chỉ bản đã rà soát mới được gửi)
exports.sendReply = async (req, res) => {
  try {
    const reviewId = cleanText(req.params.reviewId);
    const expectedVersion = Number(req.body?.version);
    const review = await Review.findOne({ Review_id: reviewId }).lean();

    if (!review) {
      return res.status(404).json({ success: false, message: "Không tìm thấy đánh giá" });
    }

    if (review.Reply_status === "replied") {
      return res.status(409).json({ success: false, message: "Đánh giá này đã được phản hồi" });
    }

    if (review.Moderation_status !== "approved") {
      return res.status(409).json({ success: false, message: "Chỉ phản hồi được đánh giá đã duyệt" });
    }

    if (!review.Reply_reviewed || !review.Reply_draft) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng lưu và rà soát nội dung phản hồi trước khi gửi",
      });
    }

    if (Number.isFinite(expectedVersion) && expectedVersion !== (review.Reply_draft_version || 0)) {
      return res.status(409).json({
        success: false,
        message: "Bản nháp đã được cập nhật. Vui lòng tải lại để xem nội dung mới nhất.",
      });
    }

    const invalid = validateReplyContent(review.Reply_draft);
    if (invalid) {
      return res.status(400).json({ success: false, message: invalid });
    }

    const actor = await getActor(req);
    const now = new Date();

    const result = await Review.updateOne(
      {
        Review_id: reviewId,
        Moderation_status: "approved",
        Reply_status: { $ne: "replied" },
        Reply_draft_version: review.Reply_draft_version || 0,
      },
      {
        $set: {
          Reply_content: review.Reply_draft,
          Reply_status: "replied",
          Replied_by: actor.id,
          Replied_by_name: actor.name,
          Replied_at: now,
        },
        $push: {
          History: {
            Event: "replied",
            Actor_id: actor.id,
            Actor_name: actor.name,
            Note: "Staff gửi phản hồi cho khách hàng",
            Created_at: now,
          },
        },
      }
    );

    if (result.modifiedCount === 0) {
      const failure = await conflictOrMissing(reviewId);
      return res.status(failure.status).json({ success: false, message: failure.message });
    }

    notifyCustomerOfReply(review);

    return res.json({ success: true, message: "Đã gửi phản hồi cho khách hàng" });
  } catch (error) {
    console.error("Lỗi khi gửi phản hồi đánh giá:", error);
    return res.status(500).json({ success: false, message: "Gửi phản hồi thất bại, vui lòng thử lại" });
  }
};
