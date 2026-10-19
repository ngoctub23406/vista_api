
const bcrypt = require("bcryptjs");
const { User } = require("../../models/schema");

// Manager xem danh sách tài khoản Staff
exports.getStaffList = async (req, res) => {
  try {
    const staffList = await User.find({ Role: "Staff" })
      .select("-Password -Reset_otp -Reset_otp_expires")
      .sort({ Created_at: -1 })
      .lean();

    return res.json({
      success: true,
      data: staffList,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách tài khoản Staff",
    });
  }
};
