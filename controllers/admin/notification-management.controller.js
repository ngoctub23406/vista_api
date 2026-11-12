const notificationService = require("../../services/notification.service");

/**
 * Controller Quản lý Thông báo Vận hành (Manager <-> Staff)
 * Chỉ xử lý yêu cầu sau khi đã qua authMiddleware và requireRole
 */

// API 1: Manager phát thông báo vận hành
exports.dispatchAlert = async (req, res) => {
  try {
    const {
      title,
      message,
      priority,
      recipient_mode,
      recipient_ids,
      target_entity,
      link,
      idempotency_key,
      confirm_resend,
    } = req.body || {};

    const result = await notificationService.dispatchOperationalAlert({
      managerUser: req.user,
      title,
      message,
      priority,
      recipientMode: recipient_mode,
      recipientIds: recipient_ids,
      targetEntity: target_entity,
      link,
      idempotencyKey: idempotency_key,
      confirmResend: Boolean(confirm_resend),
    });

    const statusCode = result.isDuplicate ? 200 : 201;
    return res.status(statusCode).json({
      success: true,
      message: result.message,
      isDuplicate: result.isDuplicate,
      data: result.client,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    const response = {
      success: false,
      message: error.message || "Lỗi xử lý phát thông báo",
    };
    if (error.field) response.field = error.field;
    if (error.code) response.code = error.code;

    if (status >= 500) {
      console.error("Lỗi hệ thống khi dispatch alert:", error);
    }
    return res.status(status).json(response);
  }
};

// API 2: Manager xem lịch sử thông báo do mình gửi
exports.getSentAlerts = async (req, res) => {
  try {
    const { page, limit, priority } = req.query;

    const result = await notificationService.getSentNotifications({
      senderId: req.user.User_id,
      page,
      limit,
      priority,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Lỗi khi tải danh sách thông báo đã gửi:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Không thể tải danh sách thông báo đã gửi",
    });
  }
};

// API 3: Staff xác nhận đã tiếp nhận thông báo
exports.acknowledgeAlert = async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.User_id;

    const result = await notificationService.acknowledgeNotification({
      notificationId,
      userId,
    });

    return res.json({
      success: true,
      alreadyAcknowledged: result.alreadyAcknowledged,
      message: result.message,
      data: result.data,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status >= 500) {
      console.error("Lỗi khi xác nhận tiếp nhận thông báo:", error);
    }
    return res.status(status).json({
      success: false,
      message: error.message || "Không thể xác nhận tiếp nhận thông báo",
    });
  }
};

// API 4: Staff xem danh sách thông báo vận hành được giao cho mình
exports.getAssignedAlerts = async (req, res) => {
  try {
    const { page, limit, status, priority } = req.query;

    const result = await notificationService.getAssignedNotifications({
      staffId: req.user.User_id,
      page,
      limit,
      status,
      priority,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Lỗi khi tải thông báo được giao:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Không thể tải danh sách thông báo được giao",
    });
  }
};
