const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User } = require("../models/schema");

async function generateUniqueUserId() {
  const users = await User.find({ User_id: /^USR_\d+$/ }).select("User_id").lean();
  const maxNumber = users.reduce((max, user) => {
    const match = String(user.User_id || "").match(/^USR_(\d+)$/);
    return match ? Math.max(max, Number(match[1]) || 0) : max;
  }, 0);

  let nextNumber = maxNumber + 1;
  let candidate = `USR_${String(nextNumber).padStart(3, "0")}`;

  while (await User.exists({ User_id: candidate })) {
    nextNumber += 1;
    candidate = `USR_${String(nextNumber).padStart(3, "0")}`;
  }

  return candidate;
}


exports.register = async (req, res) => {
  try {
    const { Username, Email, Password, Full_name, Phone_number } = req.body;

    const existingEmail = await User.findOne({ Email });
    if (existingEmail) {
      return res.status(400).json({ success: false, message: "Email đã được sử dụng" });
    }

    const existingUsername = await User.findOne({ Username });
    if (existingUsername) {
      return res.status(400).json({ success: false, message: "Tên đăng nhập đã được sử dụng" });
    }

    const hashedPassword = await bcrypt.hash(Password, 10);

    const User_id = await generateUniqueUserId();

    const newUser = await User.create({
      User_id,
      Username,
      Email,
      Password: hashedPassword,
      Full_name,
      Phone_number,
      Status: "active",
      Created_at: new Date(),
    });

    const token = jwt.sign(
      { User_id: newUser.User_id, Email: newUser.Email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(201).json({
      success: true,
      message: "Đăng ký thành công!",
      token,
      user: {
        User_id: newUser.User_id,
        Username: newUser.Username,
        Email: newUser.Email,
        Full_name: newUser.Full_name,
        Phone_number: newUser.Phone_number,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


exports.login = async (req, res) => {
  try {
    const { Email, Password } = req.body;

    const user = await User.findOne({
      Email: String(Email || "").trim().toLowerCase(),
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        message: "Email hoặc mật khẩu không đúng",
      });
    }

    if (user.Status === "blocked") {
      return res.status(403).json({
        success: false,
        message: "Tài khoản đã bị khóa",
      });
    }

    if (user.Locked_Until && user.Locked_Until > new Date()) {
      return res.status(403).json({
        success: false,
        message: "Tài khoản đang bị khóa tạm thời",
      });
    }

    const isMatch = await bcrypt.compare(Password, user.Password);

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Email hoặc mật khẩu không đúng",
      });
    }

    const role = user.Role || "Customer";

    const token = jwt.sign(
      {
        User_id: user.User_id,
        Email: user.Email,
        Role: role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      message: "Đăng nhập thành công!",
      token,
      user: {
        User_id: user.User_id,
        Username: user.Username,
        Email: user.Email,
        Full_name: user.Full_name,
        Phone_number: user.Phone_number,
        Total_spent: user.Total_spent,
        Role: role,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


exports.getMe = async (req, res) => {
  try {
    const user = await User.findOne(
      { User_id: req.user.User_id },
      { Password: 0 } 
    );
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


exports.updateProfile = async (req, res) => {
  try {
    const { Full_name, Phone_number, totalSpent } = req.body;

    const updateData = {};
    if (Full_name !== undefined) updateData.Full_name = Full_name;
    if (Phone_number !== undefined) updateData.Phone_number = Phone_number;
    
    if (totalSpent !== undefined) {
      updateData.Total_spent = totalSpent;
    }

    const user = await User.findOneAndUpdate(
      { User_id: req.user.User_id },
      { $set: updateData },
      { new: true, projection: { Password: 0 } }
    );

    res.json({ success: true, message: "Cập nhật thành công!", data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;

    const user = await User.findOne({ User_id: req.user.User_id });

    const isMatch = await bcrypt.compare(oldPassword, user.Password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Mật khẩu cũ không đúng" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.findOneAndUpdate(
      { User_id: req.user.User_id },
      { Password: hashedPassword }
    );

    res.json({ success: true, message: "Đổi mật khẩu thành công!" });
  } catch (error) {
    console.error("Admin password reset email failed:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS, 
  },
});


exports.forgotPassword = async (req, res) => {
  try {
    const { Email } = req.body;

    const email = String(Email || "").trim().toLowerCase();
    const user = await User.findOne({ Email: email, Role: "Customer" });
    if (!user) {
      return res.status(404).json({ success: false, message: "Email này không tồn tại trên hệ thống!" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000);

    await User.findOneAndUpdate(
      { Email: email, Role: "Customer" },
      { $set: { Reset_otp: otp, Reset_otp_expires: otpExpires } }
    );

    const mailOptions = {
      from: `"VISTA Support" <${process.env.EMAIL_USER}>`,
      to: Email,
      subject: "[VISTA] - Mã xác thực đặt lại mật khẩu tài khoản",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; padding: 24px; border-radius: 12px;">
          <h2 style="color: #2563b0; text-align: center;">XÁC THỰC MẬT KHẨU VISTA</h2>
          <p>Xin chào <strong>${user.Full_name}</strong>,</p>
          <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu từ bạn. Vui lòng sử dụng mã OTP dưới đây để hoàn tất quy trình:</p>
          <div style="background: #f8fafc; padding: 16px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 4px; color: #2563b0; border-radius: 8px; margin: 24px 0;">
            ${otp}
          </div>
          <p style="color: #ef4444; font-size: 13px;">* Lưu ý: Mã OTP này chỉ có hiệu lực trong vòng 5 phút. Tuyệt đối không chia sẻ mã này cho bất kỳ ai.</p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
          <p style="font-size: 12px; color: #94a3b8; text-align: center;">Đây là email tự động từ hệ thống VISTA, vui lòng không phản hồi email này.</p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.json({ success: true, message: "Mã OTP đã được gửi đến email của bạn!" });
  } catch (error) {
    console.error("Email send error:", error.message);
    console.error("Email error code:", error.code);
    res.status(500).json({ success: false, message: error.message });
  }
};


exports.verifyOTP = async (req, res) => {
  try {
    const { Email, otpCode } = req.body;
    const email = String(Email || "").trim().toLowerCase();

    const user = await User.findOne({ 
      Email: email,
      Role: "Customer",
      Reset_otp: String(otpCode || "").trim(),
      Reset_otp_expires: { $gt: new Date() } 
    });

    if (!user) {
      return res.status(400).json({ success: false, message: "Mã OTP không chính xác hoặc đã hết hạn!" });
    }

    res.json({ success: true, message: "Xác thực mã OTP thành công!" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};


exports.resetPassword = async (req, res) => {
  try {
    const { Email, otpCode, Password } = req.body;
    const email = String(Email || "").trim().toLowerCase();
    const otp = String(otpCode || "").trim();

    const user = await User.findOne({ 
      Email: email,
      Role: "Customer",
      Reset_otp: otp,
      Reset_otp_expires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ success: false, message: "Yêu cầu đã hết hạn. Vui lòng thao tác lại từ đầu!" });
    }


    const hashedPassword = await bcrypt.hash(Password, 10);

    const result = await User.updateOne(
      {
        _id: user._id,
        Email: email,
        Role: "Customer",
        Reset_otp: otp,
        Reset_otp_expires: { $gt: new Date() },
      },
      { 
        $set: { Password: hashedPassword },
        $unset: { Reset_otp: "", Reset_otp_expires: "" } 
      }
    );

    if (result.matchedCount !== 1) {
      return res.status(400).json({
        success: false,
        message: "Yêu cầu đã hết hạn. Vui lòng thao tác lại từ đầu!",
      });
    }

    res.json({ success: true, message: "Đặt lại mật khẩu thành công!" });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
