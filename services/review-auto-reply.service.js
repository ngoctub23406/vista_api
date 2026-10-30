// Sinh và lưu Auto-reply cho đánh giá (BR-REV-02, BR-REV-03, BR-REV-04)
const { Order, Order_detail, Product, Product_variant, Review } = require("../models/schema");
const { generateReviewReply } = require("./review-ai.service");

const SYSTEM_AI_ACTOR = { id: "", name: "Hệ thống AI" };

// Lấy đơn hàng, biến thể và sản phẩm của một đánh giá
async function loadReviewContext(review) {
  const detail = await Order_detail.findOne({ Order_detail_id: review.Order_detail_id }).lean();
  const [order, variant] = await Promise.all([
    detail ? Order.findOne({ Order_id: detail.Order_id }).lean() : null,
    detail ? Product_variant.findOne({ Product_variant_id: detail.Product_variant_id }).lean() : null,
  ]);
  const product = variant ? await Product.findOne({ Product_id: variant.Product_id }).lean() : null;

  return { detail, order, variant, product };
}

// Gọi AI rồi lưu Auto-reply ở trạng thái chờ kiểm duyệt.
// Ném lỗi khi AI thất bại (đánh giá vẫn giữ nguyên, Staff soạn thủ công).
async function generateAndStoreAutoReply(reviewId, actor = SYSTEM_AI_ACTOR) {
  const review = await Review.findOne({ Review_id: reviewId }).lean();
  if (!review) {
    const error = new Error("Không tìm thấy đánh giá");
    error.code = "NOT_FOUND";
    throw error;
  }

  if (review.Reply_status === "replied") {
    const error = new Error("Đánh giá này đã được phản hồi");
    error.code = "ALREADY_REPLIED";
    throw error;
  }

  const { order, product, variant } = await loadReviewContext(review);
  const draft = await generateReviewReply({
    rating: review.Rating,
    comment: review.Comment,
    productName: product?.Product_name || variant?.Variant_name || "",
    customerName: order?.Receiver_name || "",
  });

  const result = await Review.updateOne(
    { Review_id: reviewId, Reply_status: { $ne: "replied" } },
    {
      $set: { AI_reply_draft: draft, Reply_status: "pending_review" },
      $push: {
        History: {
          Event: "ai_suggested",
          Actor_id: actor.id || "",
          Actor_name: actor.name || SYSTEM_AI_ACTOR.name,
          Note: "AI tạo gợi ý phản hồi, đang chờ Staff rà soát và chỉnh sửa",
          Created_at: new Date(),
        },
      },
    }
  );

  if (result.modifiedCount === 0) {
    const error = new Error("Đánh giá này đã được phản hồi");
    error.code = "ALREADY_REPLIED";
    throw error;
  }

  return draft;
}

module.exports = { loadReviewContext, generateAndStoreAutoReply, SYSTEM_AI_ACTOR };
