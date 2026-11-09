const mongoose = require("mongoose");

// Danh sách sản phẩm yêu thích của khách hàng (mỗi khách một bản ghi)
const WishlistItemSchema = new mongoose.Schema(
  {
    Product_id: { type: String, required: true },
    Added_at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const WishlistSchema = new mongoose.Schema(
  {
    User_id: { type: String, required: true, unique: true, index: true },
    Items: { type: [WishlistItemSchema], default: [] },
    Updated_at: { type: Date, default: Date.now },
  },
  { collection: "Wishlist" }
);

module.exports = mongoose.models.Wishlist || mongoose.model("Wishlist", WishlistSchema);
