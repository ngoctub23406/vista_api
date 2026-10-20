
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const { User } = require("../../models/schema");

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

const GENERIC_MESSAGE =
  "Nếu email thuộc tài khoản quản trị hợp lệ, mã xác thực sẽ được gửi đến email đó.";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function hashOtp(email, otp) {
  const secret = process.env.ADMIN_OTP_HMAC_SECRET;

  if (!secret) {
    const error = new Error("ADMIN_OTP_HMAC_SECRET is not configured.");
    error.code = "ADMIN_OTP_HMAC_SECRET_MISSING";
    throw error;
  }

  return crypto
    .createHmac("sha256", secret)
    .update(`${email}:${otp}`)
    .digest("hex");
}

function redactSecrets(value) {
  let message = String(value || "");
  const secrets = [
    process.env.EMAIL_USER,
    process.env.EMAIL_PASS,
    process.env.ADMIN_OTP_HMAC_SECRET,
    process.env.JWT_SECRET,
    process.env.MONGODB_URI,
  ].filter(Boolean);

  for (const secret of secrets) {
    message = message.split(secret).join("[REDACTED]");
  }

  return message;
}

function logFailure(step, error) {
  console.error("Admin password reset failure", {
    step,
    message: redactSecrets(error?.message || error),
    code: error?.code || null,
    responseCode: error?.responseCode || null,
    command: error?.command || null,
  });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  return left.length === right.length &&
    crypto.timingSafeEqual(left, right);
}

function isAdminRole(user) {
  return user && ["Manager", "Staff"].includes(user.Role);
}

function clearOtpFields() {
  return {
    Admin_reset_otp_hash: null,
    Admin_reset_otp_expires: null,
    Admin_reset_otp_sent_at: null,
    Admin_reset_otp_attempts: 0,
    Admin_reset_otp_locked_until: null,
  };
}

function otpIsActive(user) {
  return Boolean(
    user.Admin_reset_otp_hash &&
    user.Admin_reset_otp_expires &&
    new Date(user.Admin_reset_otp_expires).getTime() > Date.now()
  );
}

function otpMatches(user, email, otp) {
  if (!otpIsActive(user)) return false;

  const expected = hashOtp(email, otp);
  return safeEqual(user.Admin_reset_otp_hash, expected);
}

async function recordFailedAttempt(user) {
  const now = new Date();
  const nextAttempts = {
    $add: [{ $ifNull: ["$Admin_reset_otp_attempts", 0] }, 1],
  };
  const shouldLock = { $gte: [nextAttempts, MAX_ATTEMPTS] };

  const result = await User.updateOne(
    {
      _id: user._id,
      Admin_reset_otp_hash: user.Admin_reset_otp_hash,
      Admin_reset_otp_expires: { $gt: now },
      $or: [
        { Admin_reset_otp_locked_until: null },
        { Admin_reset_otp_locked_until: { $lte: now } },
      ],
    },
    [
      {
        $set: {
          Admin_reset_otp_hash: {
            $cond: [shouldLock, null, "$Admin_reset_otp_hash"],
          },
          Admin_reset_otp_expires: {
            $cond: [shouldLock, null, "$Admin_reset_otp_expires"],
          },
          Admin_reset_otp_sent_at: {
            $cond: [shouldLock, null, "$Admin_reset_otp_sent_at"],
          },
          Admin_reset_otp_attempts: {
            $cond: [shouldLock, 0, nextAttempts],
          },
          Admin_reset_otp_locked_until: {
            $cond: [
              shouldLock,
              new Date(now.getTime() + OTP_COOLDOWN_MS),
              "$Admin_reset_otp_locked_until",
            ],
          },
        },
      },
    ]
  );

  return result.modifiedCount === 1;
}

// POST /api/admin/auth/forgot-password
exports.forgotPassword = async (req, res) => {
  let phase = "request validation";

  try {
    const email = normalizeEmail(req.body?.Email);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập email hợp lệ.",
      });
    }

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      const error = new Error("EMAIL_USER or EMAIL_PASS is not configured.");
      error.code = "EMAIL_CONFIG_MISSING";
      logFailure("SMTP configuration", error);
      return res.status(500).json({
        success: false,
        message: "Không thể gửi email lúc này. Vui lòng thử lại sau.",
      });
    }

    if (!process.env.ADMIN_OTP_HMAC_SECRET) {
      const error = new Error("ADMIN_OTP_HMAC_SECRET is not configured.");
      error.code = "ADMIN_OTP_HMAC_SECRET_MISSING";
      logFailure("OTP configuration", error);
      return res.status(500).json({
        success: false,
        message: "Không thể gửi email lúc này. Vui lòng thử lại sau.",
      });
    }

    phase = "admin account lookup";
    const user = await User.findOne({
      Email: email,
      Role: { $in: ["Manager", "Staff"] },
      Status: "active",
    });

    // Không tiết lộ email có phải tài khoản Admin hay không.
    if (!user) {
      return res.json({ success: true, message: GENERIC_MESSAGE });
    }

    const now = new Date();
    const sentAt = now;

    phase = "claim OTP send cooldown and invalidate prior code";
    const claim = await User.updateOne(
      {
        _id: user._id,
        Role: { $in: ["Manager", "Staff"] },
        Status: "active",
        $and: [
          {
            $or: [
              { Admin_reset_otp_sent_at: null },
              {
                Admin_reset_otp_sent_at: {
                  $lte: new Date(now.getTime() - OTP_COOLDOWN_MS),
                },
              },
            ],
          },
          {
            $or: [
              { Admin_reset_otp_locked_until: null },
              { Admin_reset_otp_locked_until: { $lte: now } },
            ],
          },
        ],
      },
      {
        $set: {
          ...clearOtpFields(),
          Admin_reset_otp_sent_at: sentAt,
        },
      }
    );

    if (claim.modifiedCount !== 1) {
      return res.json({ success: true, message: GENERIC_MESSAGE });
    }

    phase = "OTP generation and signing";
    const otp = crypto.randomInt(100000, 1000000).toString();
    const otpHash = hashOtp(email, otp);

    let mailPhase = "SMTP configuration";
    try {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
      });

      mailPhase = "SMTP send";
      await transporter.sendMail({
        from: `"VISTA Support" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "[VISTA Admin] Mã xác thực đặt lại mật khẩu",
        text:
          `Xin chào ${user.Full_name || "Quản trị viên"},\n\n` +
          `Mã xác thực của bạn là: ${otp}\n` +
          `Mã có hiệu lực trong 5 phút. Không chia sẻ mã này với bất kỳ ai.\n\n` +
          "Nếu bạn không yêu cầu đặt lại mật khẩu, hãy bỏ qua email này.",
      });
    } catch (mailError) {
      logFailure(mailPhase, mailError);

      return res.status(500).json({
        success: false,
        message: "Không thể gửi email lúc này. Vui lòng thử lại sau.",
      });
    }

    phase = "activate OTP after email delivery";
    const activation = await User.updateOne(
      {
        _id: user._id,
        Role: { $in: ["Manager", "Staff"] },
        Status: "active",
        Admin_reset_otp_sent_at: sentAt,
      },
      {
        $set: {
          Admin_reset_otp_hash: otpHash,
          Admin_reset_otp_expires: new Date(Date.now() + OTP_TTL_MS),
          Admin_reset_otp_attempts: 0,
        },
      }
    );

    if (activation.modifiedCount !== 1) {
      const error = new Error("OTP activation did not update the account.");
      error.code = "OTP_ACTIVATION_FAILED";
      throw error;
    }

    return res.json({
      success: true,
      message: "Nếu email thuộc tài khoản quản trị hợp lệ, mã xác thực sẽ được gửi đến email đó.",
    });
  } catch (error) {
    logFailure(phase, error);
    return res.status(500).json({
      success: false,
      message: "Đã xảy ra lỗi. Vui lòng thử lại sau.",
    });
  }
};

// POST /api/admin/auth/verify-otp
exports.verifyOtp = async (req, res) => {
  let phase = "request validation";

  try {
    const email = normalizeEmail(req.body?.Email);
    const otp = String(req.body?.otpCode || "").trim();

    if (!email || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({
        success: false,
        message: "Email hoặc mã xác thực không hợp lệ.",
      });
    }

    phase = "admin account and OTP lookup";
    const user = await User.findOne({
      Email: email,
      Role: { $in: ["Manager", "Staff"] },
      Status: "active",
    });

    if (
      user &&
      user.Admin_reset_otp_locked_until &&
      new Date(user.Admin_reset_otp_locked_until).getTime() > Date.now()
    ) {
      return res.status(429).json({
        success: false,
        message: "Bạn đã nhập sai quá nhiều lần. Vui lòng yêu cầu mã mới.",
      });
    }

    if (!user || !otpIsActive(user)) {
      return res.status(400).json({
        success: false,
        message: "Mã xác thực không hợp lệ hoặc đã hết hạn.",
      });
    }

    if (!otpMatches(user, email, otp)) {
      phase = "OTP attempt update";
      await recordFailedAttempt(user);

      return res.status(400).json({
        success: false,
        message: "Mã xác thực không hợp lệ hoặc đã hết hạn.",
      });
    }

    return res.json({
      success: true,
      message: "Xác thực mã thành công.",
    });
  } catch (error) {
    logFailure(phase, error);
    return res.status(500).json({
      success: false,
      message: "Đã xảy ra lỗi. Vui lòng thử lại sau.",
    });
  }
};

// POST /api/admin/auth/reset-password
exports.resetPassword = async (req, res) => {
  let phase = "request validation";

  try {
    const email = normalizeEmail(req.body?.Email);
    const otp = String(req.body?.otpCode || "").trim();
    const password = req.body?.Password;

    if (
      !email ||
      !/^\d{6}$/.test(otp) ||
      typeof password !== "string" ||
      password.length < 8
    ) {
      return res.status(400).json({
        success: false,
        message: "Thông tin không hợp lệ. Mật khẩu phải có ít nhất 8 ký tự.",
      });
    }

    phase = "admin account and OTP lookup";
    const user = await User.findOne({
      Email: email,
      Role: { $in: ["Manager", "Staff"] },
      Status: "active",
    });

    if (
      user &&
      user.Admin_reset_otp_locked_until &&
      new Date(user.Admin_reset_otp_locked_until).getTime() > Date.now()
    ) {
      return res.status(429).json({
        success: false,
        message: "Bạn đã nhập sai quá nhiều lần. Vui lòng yêu cầu mã mới.",
      });
    }

    if (!user || !otpIsActive(user)) {
      return res.status(400).json({
        success: false,
        message: "Yêu cầu không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu mã mới.",
      });
    }

    if (!otpMatches(user, email, otp)) {
      phase = "OTP attempt update";
      await recordFailedAttempt(user);

      return res.status(400).json({
        success: false,
        message: "Mã xác thực không hợp lệ hoặc đã hết hạn.",
      });
    }

    phase = "password hash and persistence";
    const passwordHash = await bcrypt.hash(password, 10);
    const reset = await User.updateOne(
      {
        _id: user._id,
        Email: email,
        Role: { $in: ["Manager", "Staff"] },
        Status: "active",
        Admin_reset_otp_hash: user.Admin_reset_otp_hash,
        Admin_reset_otp_expires: { $gt: new Date() },
        $or: [
          { Admin_reset_otp_locked_until: null },
          { Admin_reset_otp_locked_until: { $lte: new Date() } },
        ],
      },
      {
        $set: {
          Password: passwordHash,
          ...clearOtpFields(),
        },
      }
    );

    if (reset.modifiedCount !== 1) {
      return res.status(400).json({
        success: false,
        message: "Yêu cầu không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu mã mới.",
      });
    }

    return res.json({
      success: true,
      message: "Đặt lại mật khẩu thành công.",
    });
  } catch (error) {
    logFailure(phase, error);
    return res.status(500).json({
      success: false,
      message: "Đã xảy ra lỗi. Vui lòng thử lại sau.",
    });
  }
};

// POST /api/admin/auth/change-password
exports.changePassword = async (req, res) => {
  let phase = "request validation";

  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};

    if (
      typeof currentPassword !== "string" ||
      !currentPassword ||
      typeof newPassword !== "string" ||
      typeof confirmPassword !== "string" ||
      newPassword.length < 8
    ) {
      return res.status(400).json({
        success: false,
        message: "Vui lòng nhập đầy đủ thông tin. Mật khẩu mới phải có ít nhất 8 ký tự.",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Mật khẩu mới và xác nhận mật khẩu không khớp.",
      });
    }

    phase = "admin account lookup";
    const user = await User.findOne({
      User_id: req.user.User_id,
      Role: { $in: ["Manager", "Staff"] },
      Status: "active",
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Tài khoản quản trị không còn khả dụng. Vui lòng đăng nhập lại.",
      });
    }

    phase = "current password verification";
    const isCurrentPasswordValid = await bcrypt.compare(
      currentPassword,
      user.Password,
    );

    if (!isCurrentPasswordValid) {
      return res.status(400).json({
        success: false,
        message: "Mật khẩu hiện tại không đúng.",
      });
    }

    phase = "password hash and persistence";
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const result = await User.updateOne(
      {
        _id: user._id,
        User_id: req.user.User_id,
        Role: { $in: ["Manager", "Staff"] },
        Status: "active",
        Password: user.Password,
      },
      { $set: { Password: passwordHash } },
    );

    if (result.modifiedCount !== 1) {
      return res.status(409).json({
        success: false,
        message: "Mật khẩu đã được thay đổi trong phiên này. Vui lòng đăng nhập lại.",
      });
    }

    return res.json({
      success: true,
      message: "Đổi mật khẩu thành công.",
    });
  } catch (error) {
    logFailure(phase, error);
    return res.status(500).json({
      success: false,
      message: "Không thể đổi mật khẩu lúc này. Vui lòng thử lại sau.",
    });
  }
};
