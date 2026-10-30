
const mongoose = require("mongoose");
const { Schema } = mongoose;

const UserSchema = new Schema(
  {
    User_id: { type: String, required: true, unique: true },
    Username: { type: String, required: true, unique: true, trim: true },
    Password: { type: String, required: true }, // bcrypt hash

    Phone_number: { type: String, trim: true },
    Email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    Full_name: { type: String, trim: true },

    // Phân biệt khách hàng và tài khoản quản trị
    Role: {
      type: String,
      enum: ["Customer", "Manager", "Staff"],
      default: "Customer",
    },

    // Trạng thái tài khoản theo BPMN
    Status: {
      type: String,
      enum: ["active", "blocked"],
      default: "active",
    },

    // Phục vụ khóa đăng nhập tạm thời nếu BPMN đăng nhập quy định
    Failed_Login_Count: { type: Number, default: 0 },
    Locked_Until: { type: Date, default: null },

    Created_at: { type: Date, default: Date.now },

    Reset_otp: { type: String, default: null },
    Reset_otp_expires: { type: Date, default: null },
    
    // OTP đặt lại mật khẩu riêng cho tài khoản Admin
    Admin_reset_otp_hash: { type: String, default: null },
    Admin_reset_otp_expires: { type: Date, default: null },
    Admin_reset_otp_sent_at: { type: Date, default: null },
    Admin_reset_otp_attempts: { type: Number, default: 0 },
    Admin_reset_otp_locked_until: { type: Date, default: null },

    Total_spent: { type: Number, default: 0 },
  },
  { collection: "User" }
);


const AddressSchema = new Schema(
  {
    Address_id: { type: String, required: true, unique: true },
    User_id: { type: String, required: true, ref: "User" },
    Receiver_name: { type: String, required: true },
    Receiver_phone: { type: String, required: true },
    Email: { type: String, trim: true },
    Province: { type: String, required: true },
    District: { type: String, required: true },
    Ward: { type: String, required: true },
    Specific_address: { type: String, required: true },
    Is_default: { type: Boolean, default: false },
  },
  { collection: "Address" }
);


const CategorySchema = new Schema(
  {
    Category_id: { type: String, required: true, unique: true },
    Category_name: { type: String, required: true },
    Description: { type: String },
  },
  { collection: "Category" }
);


const BrandSchema = new Schema(
  {
    Brand_id: { type: String, required: true, unique: true },
    Brand_name: { type: String, required: true },
    Description: { type: String },
    Origin_country: { type: String },
  },
  { collection: "Brand" }
);


const ProductSchema = new Schema(
  {
    Product_id: { type: String, required: true, unique: true },
    Category_id: { type: String, required: true, ref: "Category" },
    Brand_id: { type: String, required: true, ref: "Brand" },
    Product_name: { type: String, required: true },
    Description: { type: String },
    Images: [{ type: String }],
    Average_rating: { type: Number, default: 0, min: 0, max: 5 },
    Total_reviews: { type: Number, default: 0 },
    Technical_specs: { type: Schema.Types.Mixed },
    Status: {
      type: String,
      enum: ["on_sale", "out_of_stock"],
      default: "on_sale",
    },
    Discount: { type: Number, default: 0 },
    Is_Flash_Sale: { type: Boolean, default: false },
    Is_AI: { type: Boolean, default: false },
  },
  { collection: "Product" }
);


const ProductVariantSchema = new Schema(
  {
    Product_variant_id: { type: String, required: true, unique: true },
    Product_id: { type: String, required: true, ref: "Product" },
    Variant_name: { type: String, required: true },
    Attributes: { type: Schema.Types.Mixed },
    Price: { type: Number, required: true },
    Stock_quantity: { type: Number, required: true, default: 0 },
    Status: {
      type: String,
      enum: ["active", "out_of_stock"],
      default: "active",
    },
  },
  { collection: "Product_variant" }
);


const CartSchema = new Schema(
  {
    Cart_id: { type: String, required: true, unique: true },
    User_id: { type: String, required: true, ref: "User" },
    Total_product: { type: Number, default: 0 },
    Total_price: { type: Number, default: 0 },
  },
  { collection: "Cart" }
);


const CartItemSchema = new Schema(
  {
    Cart_item_id: { type: String, required: true, unique: true },
    Product_variant_id: { type: String, required: true, ref: "Product_variant" },
    Cart_id: { type: String, required: true, ref: "Cart" },
    Quantity: { type: Number, required: true, min: 1 },
    Price: { type: Number, required: true },
  },
  { collection: "Cart_item" }
);


const VoucherSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    condition: { type: String, required: true },
    type: { type: String, enum: ["percent", "shipping"], required: true },
    category: { type: String, enum: ["freeship", "discount"], required: true },
    status: {
      type: String,
      enum: ["available", "used", "expiring"],
      default: "available",
    },
    expiry: { type: String, required: true },
    daysLeft: { type: Number },
    description: { type: String, default: "" },
    benefits: [{ type: String }],
    conditions: [{ type: String }],
    startDate: { type: String, default: "" },
    minOrderValue: { type: Number, default: 0 },
    maxDiscountAmount: { type: Number, default: 0 },
    discountValue: { type: Number, default: 0 },
    usageLimit: { type: String, default: "" },
    statusText: { type: String, default: "" },
    Required_tier: {
  type: Number,
  default: 0 
}
  },
  {
    collection: "Voucher",
    timestamps: true,
  }
);


// Lịch sử chuyển trạng thái đơn hàng (Staff hoặc hệ thống giả lập ĐVVC)
const OrderStatusHistorySchema = new Schema(
  {
    From_status: { type: String, default: "" },
    To_status: { type: String, default: "" },
    Event: { type: String, required: true },
    Actor_id: { type: String, default: "" },
    Actor_name: { type: String, default: "" },
    Note: { type: String, default: "" },
    Created_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const OrderSchema = new Schema(
  {
    Order_id: { type: String, required: true, unique: true },
    User_id: { type: String, required: true, ref: "User" },
    Receiver_name: { type: String, default: "" },
    Receiver_phone: { type: String, default: "" },
    Email: { type: String, default: "" },
    Province: { type: String, default: "" },
    District: { type: String, default: "" },
    Ward: { type: String, default: "" },
    Specific_address: { type: String, default: "" },
    Address: { type: String, default: "" },
    Voucher_id: { type: String, ref: "Voucher", default: null },
    Voucher_code: { type: String, default: "" },
    Voucher_title: { type: String, default: "" },
    Voucher_discount_amount: { type: Number, default: 0 },
    Voucher_shipping_discount: { type: Number, default: 0 },
    Total_items_price: { type: Number, required: true },
    Discount_amount: { type: Number, default: 0 },
    Total_amount: { type: Number, required: true },
    Order_notes: { type: String },
    Cancel_reason: { type: String, default: "" },
    Cancel_reason_code: { type: String, default: "" }, // Mã lý do hủy (services/reason-catalog.js)
    Cancelled_by: { type: String, enum: ["", "customer", "staff", "system"], default: "" },
    Cancelled_at: { type: Date, default: null },
    Sla_reminded: { type: [String], default: [] }, // Các bước SLA đã gửi nhắc quá hạn
    Status: {
      type: String,
      enum: ["pending_payment", "processing", "shipping", "delivered", "review", "returning", "cancelled"],
      default: "pending_payment",
    },
    Processing_started_at: { type: Date, default: null },
    Status_history: { type: [OrderStatusHistorySchema], default: [] },
    Review_status: {
      type: String,
      enum: ["not_reviewed", "reviewed"],
      default: "not_reviewed",
    },
    Created_at: { type: Date, default: Date.now },
  },
  { collection: "Order" }
);


const OrderDetailSchema = new Schema(
  {
    Order_detail_id: { type: String, required: true, unique: true },
    Product_variant_id: { type: String, required: true, ref: "Product_variant" },
    Order_id: { type: String, required: true, ref: "Order" },
    Variant_name: { type: String, required: true },
    Price: { type: Number, required: true },
    Original_price: { type: Number, default: 0 },
    Discount_percent: { type: Number, default: 0 },
    Quantity: { type: Number, required: true, min: 1 },
    Total_price: { type: Number, required: true },
  },
  { collection: "Order_detail" }
);


const PaymentSchema = new Schema(
  {
    Payment_id: { type: String, required: true, unique: true },
    Order_id: { type: String, required: true, ref: "Order" },
    Payment_type: {
      type: String,
      enum: ["COD", "MoMo", "VNPay", "BankTransfer"],
      required: true,
    },
    Payment_status: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },
    Amount: { type: Number, default: 0 },
    Transaction_code: { type: String, default: "" },
    Paid_at: { type: Date, default: null },
    Failure_reason: { type: String, default: "" },
  },
  { collection: "Payment" }
);


const DeliverySchema = new Schema(
  {
    Delivery_id: { type: String, required: true, unique: true },
    Order_id: { type: String, required: true, ref: "Order" },
    Shipping_partner: { type: String },
    Tracking_number: { type: String },
    Original_shipping_fee: { type: Number, default: 0 },
    Shipping_discount: { type: Number, default: 0 },
    Shipping_fee: { type: Number, default: 0 },
    Estimated_delivery_date: { type: Date },
    Delivered_at: { type: Date, default: null },
    Status: {
      type: String,
      enum: ["pending", "shipping", "delivered", "failed"],
      default: "pending",
    },
  },
  { collection: "Delivery" }
);


const ReturnOrderTimelineSchema = new Schema(
  {
    Step: { type: String, required: true },
    Title: { type: String, required: true },
    Description: { type: String, default: "" },
    Actor_id: { type: String, default: "" },
    Actor_name: { type: String, default: "" },
    Actor_role: { type: String, default: "" },
    Status: { type: String, default: "" },
    Created_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ReturnOrderSchema = new Schema(
  {
    Return_order_id: { type: String, required: true, unique: true },
    Order_id: { type: String, required: true, ref: "Order" },
    Product_variant_id: { type: String, required: true, ref: "Product_variant" },
    Return_quantity: { type: Number, default: 1, min: 1 },
    Reason_type: { type: String, required: true, trim: true },
    Reason_codes: { type: [String], default: [] },
    Description: { type: String, default: "" },
    Evidence_images: [{ type: String }],
    Refund_amount: { type: Number, default: 0 },
    Return_name: { type: String, default: "" },
    Return_phone: { type: String, default: "" },
    Return_email: { type: String, default: "" },
    Return_address: { type: String, default: "" },
    Return_tracking_number: { type: String, default: "" },
    Status: {
      type: String,
      enum: ["pending", "approved", "rejected", "completed", "refunded"],
      default: "pending",
    },
    Handled_by: { type: String, default: "" },
    Handled_by_name: { type: String, default: "" },
    Handled_at: { type: Date, default: null },
    Reject_reason: { type: String, default: "" },
    Inspected_by: { type: String, default: "" },
    Inspected_by_name: { type: String, default: "" },
    Inspected_at: { type: Date, default: null },
    Inspected_result: { type: String, default: "" },
    Timeline: { type: [ReturnOrderTimelineSchema], default: [] },
    Created_at: { type: Date, default: Date.now },
  },
  { collection: "Return_order" }
);

ReturnOrderSchema.index({ Created_at: -1, _id: -1 });
ReturnOrderSchema.index({ Order_id: 1 });
ReturnOrderSchema.index({ Status: 1 });



// Lịch sử xử lý một đánh giá (kiểm duyệt, gợi ý AI, lưu nháp, gửi phản hồi)
const ReviewHistorySchema = new Schema(
  {
    Event: { type: String, required: true },
    Actor_id: { type: String, default: "" },
    Actor_name: { type: String, default: "" },
    Note: { type: String, default: "" },
    Created_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ReviewSchema = new Schema(
  {
    Review_id: { type: String, required: true, unique: true },
    Order_detail_id: { type: String, required: true, ref: "Order_detail" },
    Rating: { type: Number, required: true, min: 1, max: 5 },
    Comment: { type: String, default: "" },
    Images: [{ type: String }],

    Moderation_status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    Moderated_by: { type: String, default: "", ref: "User" },
    Moderated_by_name: { type: String, default: "" },
    Moderated_at: { type: Date, default: null },
    Moderation_note: { type: String, default: "" },

    AI_reply_draft: { type: String, default: "" },
    Reply_status: {
      type: String,
      enum: ["no_auto_reply", "pending_review", "replied"],
      default: "no_auto_reply",
    },
    Reply_draft: { type: String, default: "" }, 
    Reply_draft_version: { type: Number, default: 0 },
    Reply_draft_by_name: { type: String, default: "" },
    Reply_draft_at: { type: Date, default: null },
    Reply_reviewed: { type: Boolean, default: false },
    Reply_content: { type: String, default: "" },
    Replied_by: { type: String, default: "", ref: "User" },
    Replied_by_name: { type: String, default: "" },
    Replied_at: { type: Date, default: null },

    History: { type: [ReviewHistorySchema], default: [] },
    Created_at: { type: Date, default: Date.now },
  },
  { collection: "Review" }
);


const SessionSchema = new Schema(
  {
    Session_id: { type: String, required: true, unique: true },
    User_id: { type: String, required: true, ref: "User" },
    Title: { type: String, default: "Cuộc trò chuyện mới" },
    Create_at: { type: Date, default: Date.now },
    Updated_at: { type: Date, default: Date.now },
  },
  { collection: "Session" }
);


const MessageSchema = new Schema(
  {
    Message_id: { type: String, required: true, unique: true },
    Session_id: { type: String, required: true, ref: "Session" },
    Content: { type: String, required: true },
    Products_json: { type: String, default: null },
    Vouchers_json: { type: String, default: null },
    Created_at: { type: Date, default: Date.now },
    Sender_type: {
      type: String,
      enum: ["user", "ai"],
      required: true,
    },
  },
  { collection: "Message" }
);


const AIComparisonSchema = new Schema(
  {
    AI_comparison_id: { type: String, required: true, unique: true },
    User_id: { type: String, required: true, ref: "User" },
    Target_products: [{ type: String, ref: "Product" }],
    User_requirements: { type: String },
    Ai_response_summary: { type: String },
    Created_at: { type: Date, default: Date.now },
  },
  { collection: "AI_comparison" }
);


module.exports = {
  User: mongoose.model("User", UserSchema),
  Address: mongoose.model("Address", AddressSchema),
  Category: mongoose.model("Category", CategorySchema),
  Brand: mongoose.model("Brand", BrandSchema),
  Product: mongoose.model("Product", ProductSchema),
  Product_variant: mongoose.model("Product_variant", ProductVariantSchema),
  Cart: mongoose.model("Cart", CartSchema),
  Cart_item: mongoose.model("Cart_item", CartItemSchema),
  Voucher: mongoose.model("Voucher", VoucherSchema),
  Order: mongoose.model("Order", OrderSchema),
  Order_detail: mongoose.model("Order_detail", OrderDetailSchema),
  Payment: mongoose.model("Payment", PaymentSchema),
  Delivery: mongoose.model("Delivery", DeliverySchema),
  Return_order: mongoose.model("Return_order", ReturnOrderSchema),
  Review: mongoose.model("Review", ReviewSchema),
  Session: mongoose.model("Session", SessionSchema),
  Message: mongoose.model("Message", MessageSchema),
  AI_comparison: mongoose.model("AI_comparison", AIComparisonSchema),
};
