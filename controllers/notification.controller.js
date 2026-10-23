const Notification = require("../models/notification.model");
const { toClient } = require("../services/notification.service");
const { isAdminRole } = require("../services/socket.service");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Staff/Manager xem thông báo chung của Admin, khách xem thông báo của chính mình
function buildScope(req) {
  if (isAdminRole(req.user.Role)) {
    return { Audience: "admin" };
  }
  return { Audience: "customer", User_id: req.user.User_id };
}

exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user.User_id;
    const scope = buildScope(req);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));

    const [items, unreadCount] = await Promise.all([
      Notification.find(scope).sort({ Created_at: -1 }).limit(limit).lean(),
      Notification.countDocuments({ ...scope, Read_by: { $ne: userId } }),
    ]);

    return res.json({
      success: true,
      data: {
        items: items.map((item) => toClient(item, userId)),
        unreadCount,
      },
    });
  } catch (error) {
    console.error("Lỗi khi lấy thông báo:", error);
    return res.status(500).json({ success: false, message: "Không thể tải thông báo" });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const result = await Notification.updateOne(
      { ...buildScope(req), Notification_id: String(req.params.id || "").trim() },
      { $addToSet: { Read_by: req.user.User_id } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Không tìm thấy thông báo" });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Lỗi khi đánh dấu đã đọc:", error);
    return res.status(500).json({ success: false, message: "Không thể cập nhật thông báo" });
  }
};

exports.markAllAsRead = async (req, res) => {
  try {
    const userId = req.user.User_id;
    await Notification.updateMany(
      { ...buildScope(req), Read_by: { $ne: userId } },
      { $addToSet: { Read_by: userId } }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("Lỗi khi đánh dấu tất cả đã đọc:", error);
    return res.status(500).json({ success: false, message: "Không thể cập nhật thông báo" });
  }
};
