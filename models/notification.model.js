const mongoose = require("mongoose");

// Thông báo cho Admin (Staff/Manager dùng chung) hoặc cho từng khách hàng
const NotificationSchema = new mongoose.Schema(
  {
    Notification_id: { type: String, required: true, unique: true },
    Audience: { type: String, enum: ["admin", "customer"], required: true, index: true },
    User_id: { type: String, default: "", index: true }, // Khách nhận thông báo (Audience = customer)
    Type: { type: String, required: true },
    Title: { type: String, required: true },
    Message: { type: String, default: "" },
    Order_id: { type: String, default: "" },
    Link: { type: String, default: "" },
    Read_by: { type: [String], default: [] }, // Danh sách User_id đã đọc
    Created_at: { type: Date, default: Date.now, index: true },
  },
  { collection: "Notification" }
);

module.exports = mongoose.models.Notification || mongoose.model("Notification", NotificationSchema);
