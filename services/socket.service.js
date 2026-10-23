const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const { User } = require("../models/schema");

const ADMIN_ROLES = ["Staff", "Manager"];
const ADMIN_ROOM = "admins";

let io = null;

function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

function userRoom(userId) {
  return `user:${userId}`;
}

// Khởi tạo Socket.IO, xác thực bằng JWT gửi trong handshake.auth.token
function init(httpServer, { corsOrigin } = {}) {
  io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error("UNAUTHORIZED"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findOne({ User_id: decoded.User_id })
        .select("User_id Role Status")
        .lean();

      if (!user || user.Status === "blocked") {
        return next(new Error("UNAUTHORIZED"));
      }

      socket.data.userId = user.User_id;
      socket.data.role = user.Role || "Customer";
      return next();
    } catch (error) {
      return next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    const { userId, role } = socket.data;
    socket.join(isAdminRole(role) ? ADMIN_ROOM : userRoom(userId));
  });

  return io;
}

function emitToAdmins(payload) {
  io?.to(ADMIN_ROOM).emit("notification:new", payload);
}

function emitToUser(userId, payload) {
  if (!userId) return;
  io?.to(userRoom(userId)).emit("notification:new", payload);
}

// Tín hiệu "đơn hàng vừa thay đổi" để màn hình đang mở tự tải lại dữ liệu
function emitOrderUpdated(userId, payload) {
  io?.to(ADMIN_ROOM).emit("order:updated", payload);
  if (userId) {
    io?.to(userRoom(userId)).emit("order:updated", payload);
  }
}

module.exports = {
  init,
  isAdminRole,
  emitToAdmins,
  emitToUser,
  emitOrderUpdated,
};
