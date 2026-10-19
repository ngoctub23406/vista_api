
const jwt = require("jsonwebtoken");
const { User } = require("../models/schema");

const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Vui lòng đăng nhập để tiếp tục",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Kiểm tra tài khoản hiện tại trong database
    const user = await User.findOne({ User_id: decoded.User_id })
      .select("User_id Email Role Status");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Tài khoản không tồn tại",
      });
    }

    if (user.Status === "blocked") {
      return res.status(403).json({
        success: false,
        message: "Tài khoản đã bị khóa",
      });
    }

    // Dùng Role mới nhất trong database, không chỉ tin Role trong token
    req.user = {
      ...decoded,
      User_id: user.User_id,
      Email: user.Email,
      Role: user.Role || "Customer",
    };

    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" ||
        error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Token không hợp lệ hoặc đã hết hạn",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Lỗi xác thực tài khoản",
    });
  }
};

// Kiểm tra quyền theo Role
authMiddleware.requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Vui lòng đăng nhập để tiếp tục",
      });
    }

    if (!allowedRoles.includes(req.user.Role)) {
      return res.status(403).json({
        success: false,
        message: "Bạn không có quyền truy cập chức năng này",
      });
    }

    next();
  };
};

module.exports = authMiddleware;
