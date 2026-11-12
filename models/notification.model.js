const mongoose = require("mongoose");

// Trạng thái tiếp nhận độc lập của từng Staff
const RecipientSchema = new mongoose.Schema(
  {
    User_id: { type: String, required: true },
    Status: {
      type: String,
      enum: ["sent", "acknowledged"],
      default: "sent",
    },
    Read_at: { type: Date, default: null },
    Acknowledged_at: { type: Date, default: null },
  },
  { _id: false }
);

// Liên kết thực thể nghiệp vụ (Đơn hàng, Đổi trả, Đánh giá, Hệ thống)
const TargetEntitySchema = new mongoose.Schema(
  {
    Entity_type: {
      type: String,
      enum: ["order", "return", "review", "system"],
      default: "system",
    },
    Entity_id: { type: String, default: "" },
  },
  { _id: false }
);

// Thông báo: Khách hàng (customer), Admin chung (admin) hoặc Thông báo vận hành riêng cho Staff (staff_operational)
const NotificationSchema = new mongoose.Schema(
  {
    Notification_id: { type: String, required: true, unique: true },
    Audience: {
      type: String,
      enum: ["admin", "customer", "staff_operational"],
      required: true,
      index: true,
    },
    User_id: { type: String, default: "", index: true }, // Dành cho khách nhận thông báo cá nhân (Audience = customer)
    Type: { type: String, required: true },
    Title: { type: String, required: true },
    Message: { type: String, default: "" },
    Order_id: { type: String, default: "" },
    Link: { type: String, default: "" },
    Read_by: { type: [String], default: [] }, // Danh sách User_id đã đọc (tương thích backward)

    // Bổ sung cho Thông báo Vận hành Manager <-> Staff (Giai đoạn 1)
    Sender_id: { type: String, default: "", index: true },
    Sender_name: { type: String, default: "" },
    Priority: {
      type: String,
      enum: ["normal", "important", "urgent"],
      default: "normal",
      index: true,
    },
    Target_entity: {
      type: TargetEntitySchema,
      default: () => ({ Entity_type: "system", Entity_id: "" }),
    },
    Recipients: {
      type: [RecipientSchema],
      default: [],
    },
    Idempotency_key: {
      type: String,
      default: null,
      index: true,
    },

    Created_at: { type: Date, default: Date.now, index: true },
  },
  { collection: "Notification" }
);

// Index hỗ trợ tìm nhanh thông báo giao cho từng Staff
NotificationSchema.index({ Audience: 1, "Recipients.User_id": 1, Created_at: -1 });
NotificationSchema.index({ Audience: 1, Sender_id: 1, Created_at: -1 });

module.exports = mongoose.models.Notification || mongoose.model("Notification", NotificationSchema);
