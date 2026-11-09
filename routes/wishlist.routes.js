const express = require("express");
const router = express.Router();

const authMiddleware = require("../middleware/auth.middleware");
const wishlistController = require("../controllers/wishlist.controller");

// Khách chưa đăng nhập vẫn xem được thông tin sản phẩm trong danh sách lưu trên trình duyệt
router.post("/lookup", wishlistController.lookupProducts);

// Danh sách gắn với tài khoản khách hàng đăng nhập
router.get("/", authMiddleware, authMiddleware.requireRole("Customer"), wishlistController.getWishlist);
router.post("/merge", authMiddleware, authMiddleware.requireRole("Customer"), wishlistController.mergeWishlist);
router.delete("/", authMiddleware, authMiddleware.requireRole("Customer"), wishlistController.clearWishlist);
router.post("/:productId", authMiddleware, authMiddleware.requireRole("Customer"), wishlistController.addItem);
router.delete("/:productId", authMiddleware, authMiddleware.requireRole("Customer"), wishlistController.removeItem);

module.exports = router;
