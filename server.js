const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const connectDB = require("./config/db");
const shippingSimulator = require("./jobs/shipping-simulator.job");

dotenv.config();
connectDB();

const app = express();
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "50mb";

app.use(cors({
  origin: 'http://localhost:4200',
  credentials: true
}));
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large" || err?.status === 413) {
    return res.status(413).json({
      success: false,
      message: "Dung lượng ảnh/video bằng chứng quá lớn. Vui lòng chọn tệp nhỏ hơn rồi thử lại.",
    });
  }

  return next(err);
});

app.get("/", (req, res) => {
  res.json({ message: "VISTA API is running!" });
});

const PORT = process.env.PORT || 5000;
const http = require("http");
const socketService = require("./services/socket.service");

// Dùng chung một HTTP server cho Express và Socket.IO (thông báo realtime)
const server = http.createServer(app);
socketService.init(server, { corsOrigin: "http://localhost:4200" });

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Giả lập đơn vị vận chuyển cập nhật trạng thái đơn hàng
shippingSimulator.start();

// Nhắc Admin các đơn quá hạn xử lý (SLA)
require("./jobs/sla-reminder.job").start();

const productRoutes = require("./routes/product.routes");
app.use("/api/products", productRoutes);

const authRoutes = require("./routes/auth.routes");
app.use("/api/auth", authRoutes);

const cartRoutes = require("./routes/cart.routes");
app.use("/api/cart", cartRoutes);

const voucherRoutes = require("./routes/voucher.routes");
app.use("/api/vouchers", voucherRoutes);

const addressRoutes = require("./routes/address.routes");
app.use("/api/addresses", addressRoutes);

const orderHistoryRoutes = require('./routes/order-history.routes');
app.use('/api/order-history', orderHistoryRoutes);

const returnOrderRoutes = require('./routes/return-order.routes');
app.use('/api/return-orders', returnOrderRoutes);

const orderRoutes = require("./routes/order.routes");
app.use("/api/orders", orderRoutes);

const paymentRoutes = require("./routes/payment.routes");
app.use("/api/payments", paymentRoutes);

const reviewRoutes = require('./routes/review.routes');
app.use('/api/reviews', reviewRoutes);

const chatbotRoutes = require("./routes/chatbot.routes");
app.use("/api/chatbot", chatbotRoutes);

const adminRoutes = require("./routes/admin.routes");
app.use("/api/admin", adminRoutes);

const notificationRoutes = require("./routes/notification.routes");
app.use("/api/notifications", notificationRoutes);