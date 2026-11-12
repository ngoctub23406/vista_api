const Notification = require("../models/notification.model");
const { toClient } = require("../services/notification.service");
const { isAdminRole } = require("../services/socket.service");

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Phân định phạm vi thông báo theo vai trò người dùng
function buildScope(req) {
  if (req.user.Role === "Manager") {
    return {
      Audience: "admin",
      Type: { $ne: "order_completed" },
    };
  }
  if (req.user.Role === "Staff") {
    return {
      $or: [
        { Audience: "admin", Type: { $ne: "order_completed" } },
        { Audience: "staff_operational", "Recipients.User_id": req.user.User_id },
      ],
    };
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
    const userId = req.user.User_id;
    const notificationId = String(req.params.id || "").trim();
    const scope = buildScope(req);

    const doc = await Notification.findOne({ ...scope, Notification_id: notificationId });
    if (!doc) {
      return res.status(404).json({ success: false, message: "Không tìm thấy thông báo" });
    }

    const now = new Date();
    if (doc.Audience === "staff_operational") {
      await Notification.updateOne(
        { Notification_id: notificationId, "Recipients.User_id": userId },
        {
          $addToSet: { Read_by: userId },
          $set: { "Recipients.$.Read_at": now },
        }
      );
    } else {
      await Notification.updateOne(
        { Notification_id: notificationId },
        { $addToSet: { Read_by: userId } }
      );
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
    const scope = buildScope(req);

    await Notification.updateMany(
      { ...scope, Read_by: { $ne: userId } },
      { $addToSet: { Read_by: userId } }
    );

    if (req.user.Role === "Staff") {
      await Notification.updateMany(
        {
          Audience: "staff_operational",
          "Recipients.User_id": userId,
          "Recipients.Read_at": null,
        },
        {
          $set: { "Recipients.$[elem].Read_at": new Date() },
        },
        {
          arrayFilters: [{ "elem.User_id": userId, "elem.Read_at": null }],
        }
      );
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Lỗi khi đánh dấu tất cả đã đọc:", error);
    return res.status(500).json({ success: false, message: "Không thể cập nhật thông báo" });
  }
};
