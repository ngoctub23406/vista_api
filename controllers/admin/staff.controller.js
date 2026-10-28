const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { User } = require("../../models/schema");
const { normalizePhone, validateEmail, validateFullName, validatePhone } = require("./staff.validation");

// Quản lý nhân sự (Manager): danh sách, chi tiết, thêm, sửa, khóa / mở khóa tài khoản nội bộ.
// Dữ liệu lấy trực tiếp từ collection "User" (Role = Manager / Staff).
// Phân quyền (chỉ Manager) được áp ở admin.routes.js.

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const LIST_ROLES = ["Manager", "Staff"]; // vai trò hiển thị trong danh sách nhân sự
const MANAGED_ROLE = "Staff"; // Manager chỉ được thêm / sửa / khóa tài khoản Staff
const STATUSES = ["active", "blocked"];
const USER_ID_RETRIES = 3;

// Chỉ trả về các trường cần hiển thị, không bao giờ trả mật khẩu / OTP
const PUBLIC_FIELDS = "User_id Full_name Username Email Phone_number Role Status Created_at";

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// field (tùy chọn): tên trường dữ liệu gây lỗi để giao diện báo lỗi đúng ô nhập
function fail(res, status, message, field) {
  return res.status(status).json(field ? { success: false, message, field } : { success: false, message });
}

// Regex khớp số điện thoại đã lưu dù có khoảng trắng giữa các chữ số (vd "0903 123 456")
function phoneLookupPattern(phone) {
  const digits = phone.split("").map(escapeRegex).join("[\\s.\\-]*");
  return new RegExp(`^\\s*${digits}\\s*$`);
}

function toStaffItem(user) {
  return {
    User_id: user.User_id,
    Full_name: user.Full_name || user.Username || "",
    Username: user.Username || "",
    Email: user.Email || "",
    Phone_number: user.Phone_number || "",
    Role: user.Role,
    Status: user.Status || "active",
    Created_at: user.Created_at || null,
  };
}

// Mã nhân sự theo quy ước của hệ thống: USR_001, USR_002, ...
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

// Username là trường bắt buộc & duy nhất của User; sinh từ phần đầu email
async function generateUniqueUsername(email) {
  const base =
    email
      .split("@")[0]
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "")
      .slice(0, 30) || "staff";

  let candidate = base;
  let suffix = 1;

  while (await User.exists({ Username: candidate })) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }

  return candidate;
}

// Kiểm tra dữ liệu form Thêm / Chỉnh sửa (quy tắc ở staff.validation.js).
// Trả về { error, field } hoặc { value }.
function validateStaffInput(body) {
  const fullName = validateFullName(body.Full_name);
  if (fullName.error) return { error: fullName.error, field: "Full_name" };

  const email = validateEmail(body.Email);
  if (email.error) return { error: email.error, field: "Email" };

  const phone = validatePhone(body.Phone_number);
  if (phone.error) return { error: phone.error, field: "Phone_number" };

  return { value: { Full_name: fullName.value, Email: email.value, Phone_number: phone.value } };
}

// Vai trò chỉ được là Staff (không cấp / đổi sang Manager)
function validateRole(role) {
  if (role === undefined || role === null || role === "") return null;
  return role === MANAGED_ROLE ? null : "Manager chỉ được quản lý tài khoản có vai trò Staff";
}

function validateStatus(status) {
  if (status === undefined || status === null || status === "") return null;
  return STATUSES.includes(status) ? null : "Trạng thái không hợp lệ";
}

// Email / số điện thoại phải duy nhất trong hệ thống (loại trừ chính tài khoản đang sửa)
async function isEmailTaken(email, excludeUserId) {
  if (!email) return false;
  const exclude = excludeUserId ? { User_id: { $ne: excludeUserId } } : {};
  return Boolean(await User.exists({ ...exclude, Email: email }));
}

async function isPhoneTaken(phone, excludeUserId) {
  if (!phone) return false;
  const exclude = excludeUserId ? { User_id: { $ne: excludeUserId } } : {};
  return Boolean(await User.exists({ ...exclude, Phone_number: phoneLookupPattern(phone) }));
}

// Trả về { error, field } nếu email / số điện thoại đã thuộc tài khoản khác
async function findDuplicate({ email, phone, excludeUserId }) {
  if (await isEmailTaken(email, excludeUserId)) {
    return { error: "Email đã được sử dụng", field: "Email" };
  }

  if (await isPhoneTaken(phone, excludeUserId)) {
    return { error: "Số điện thoại đã được sử dụng", field: "Phone_number" };
  }

  return null;
}

// Chuyển lỗi trùng khóa duy nhất của MongoDB (tranh chấp đồng thời) thành thông báo dễ hiểu
function duplicateKeyMessage(error) {
  const key = Object.keys(error?.keyPattern || error?.keyValue || {})[0];
  if (key === "Email") return "Email đã được sử dụng";
  if (key === "Username") return "Tên đăng nhập đã được sử dụng";
  if (key === "User_id") return "";
  return "Dữ liệu đã tồn tại trong hệ thống";
}

function duplicateKeyField(error) {
  const key = Object.keys(error?.keyPattern || error?.keyValue || {})[0];
  return key === "Email" ? "Email" : undefined;
}

function logAction(req, action, target) {
  // Chỉ ghi mã tài khoản, không ghi thông tin nhạy cảm
  console.info("[admin/staff]", action, {
    actor: req.user?.User_id,
    target: target?.User_id,
    at: new Date().toISOString(),
  });
}

// Tìm tài khoản Staff cần thao tác; nếu không hợp lệ thì trả lỗi và trả về null
async function loadManagedStaff(req, res) {
  const userId = cleanText(req.params.userId);
  const user = userId ? await User.findOne({ User_id: userId }).select(PUBLIC_FIELDS) : null;

  if (!user || !LIST_ROLES.includes(user.Role)) {
    fail(res, 404, "Không tìm thấy nhân viên");
    return null;
  }

  if (user.Role !== MANAGED_ROLE) {
    fail(res, 403, "Không thể thao tác trên tài khoản Manager");
    return null;
  }

  return user;
}

// GET /api/admin/staff?keyword=&role=&status=&page=&limit=
exports.getStaffList = async (req, res) => {
  try {
    const keyword = cleanText(req.query.keyword);
    const role = cleanText(req.query.role);
    const status = cleanText(req.query.status);
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(parsePositiveInt(req.query.limit, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);

    const filter = { Role: { $in: LIST_ROLES } };

    if (LIST_ROLES.includes(role)) filter.Role = role;
    if (STATUSES.includes(status)) filter.Status = status;

    if (keyword) {
      const pattern = new RegExp(escapeRegex(keyword), "i");
      filter.$or = [{ Full_name: pattern }, { Email: pattern }];
    }

    const [items, total, systemTotal] = await Promise.all([
      User.find(filter)
        .select(PUBLIC_FIELDS)
        .sort({ Created_at: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
      User.countDocuments({ Role: { $in: LIST_ROLES } }),
    ]);

    return res.json({
      success: true,
      data: {
        items: items.map(toStaffItem),
        total,
        page,
        limit,
        system_total: systemTotal,
      },
    });
  } catch (error) {
    console.error("getStaffList error:", error.message);
    return fail(res, 500, "Không thể lấy danh sách nhân viên");
  }
};

// GET /api/admin/staff/availability?email=&phone=&exclude=
// Giao diện gọi khi nhập form Thêm / Chỉnh sửa để báo email / số điện thoại đã được dùng ngay lúc đó.
// Chỉ kiểm tra giá trị hợp lệ về định dạng; "exclude" là mã nhân viên đang sửa (không tính là trùng).
exports.checkAvailability = async (req, res) => {
  try {
    const excludeUserId = cleanText(req.query.exclude);
    const email = validateEmail(req.query.email);
    const phone = validatePhone(req.query.phone);

    const [emailTaken, phoneTaken] = await Promise.all([
      email.value ? isEmailTaken(email.value, excludeUserId) : false,
      phone.value ? isPhoneTaken(phone.value, excludeUserId) : false,
    ]);

    return res.json({ success: true, data: { email_taken: emailTaken, phone_taken: phoneTaken } });
  } catch (error) {
    console.error("checkAvailability error:", error.message);
    return fail(res, 500, "Không thể kiểm tra email / số điện thoại");
  }
};

// GET /api/admin/staff/:userId
exports.getStaffDetail = async (req, res) => {
  try {
    const userId = cleanText(req.params.userId);
    const user = userId
      ? await User.findOne({ User_id: userId, Role: { $in: LIST_ROLES } }).select(PUBLIC_FIELDS).lean()
      : null;

    if (!user) return fail(res, 404, "Không tìm thấy nhân viên");

    return res.json({ success: true, data: toStaffItem(user) });
  } catch (error) {
    console.error("getStaffDetail error:", error.message);
    return fail(res, 500, "Không thể lấy thông tin nhân viên");
  }
};

// POST /api/admin/staff
exports.createStaff = async (req, res) => {
  try {
    const body = req.body || {};

    const roleError = validateRole(body.Role);
    if (roleError) return fail(res, 400, roleError);

    const statusError = validateStatus(body.Status);
    if (statusError) return fail(res, 400, statusError);

    const { error, field, value } = validateStaffInput(body);
    if (error) return fail(res, 400, error, field);

    const duplicate = await findDuplicate({ email: value.Email, phone: value.Phone_number });
    if (duplicate) return fail(res, 409, duplicate.error, duplicate.field);

    // Hệ thống không đặt mật khẩu hộ: tạo mật khẩu ngẫu nhiên không ai biết,
    // nhân viên tự đặt mật khẩu qua chức năng "Quên mật khẩu" (OTP gửi về email).
    const password = await bcrypt.hash(crypto.randomBytes(24).toString("hex"), 10);
    const username = await generateUniqueUsername(value.Email);

    let created = null;

    for (let attempt = 1; attempt <= USER_ID_RETRIES && !created; attempt += 1) {
      try {
        created = await User.create({
          User_id: await generateUniqueUserId(),
          Username: username,
          Password: password,
          Full_name: value.Full_name,
          Email: value.Email,
          Phone_number: value.Phone_number || undefined,
          Role: MANAGED_ROLE,
          Status: body.Status || "active",
          Created_at: new Date(),
        });
      } catch (error) {
        const retryable = error?.code === 11000 && !duplicateKeyMessage(error);
        if (!retryable || attempt === USER_ID_RETRIES) throw error;
      }
    }

    logAction(req, "create", created);

    return res.status(201).json({
      success: true,
      message: "Thêm nhân viên thành công",
      data: toStaffItem(created),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return fail(
        res,
        409,
        duplicateKeyMessage(error) || "Không thể tạo mã nhân viên, vui lòng thử lại",
        duplicateKeyField(error)
      );
    }

    console.error("createStaff error:", error.message);
    return fail(res, 500, "Không thể thêm nhân viên");
  }
};

// PATCH /api/admin/staff/:userId
exports.updateStaff = async (req, res) => {
  try {
    const body = req.body || {};

    const roleError = validateRole(body.Role);
    if (roleError) return fail(res, 400, roleError);

    const statusError = validateStatus(body.Status);
    if (statusError) return fail(res, 400, statusError);

    const { error, field, value } = validateStaffInput(body);
    if (error) return fail(res, 400, error, field);

    const user = await loadManagedStaff(req, res);
    if (!user) return undefined;

    const duplicate = await findDuplicate({
      email: value.Email,
      phone: value.Phone_number,
      excludeUserId: user.User_id,
    });
    if (duplicate) return fail(res, 409, duplicate.error, duplicate.field);

    const update = {
      Full_name: value.Full_name,
      Email: value.Email,
    };

    // Không gửi Phone_number → giữ nguyên; gửi rỗng → xóa số điện thoại
    if (body.Phone_number !== undefined) update.Phone_number = value.Phone_number;

    // Đổi trạng thái trong form Chỉnh sửa: khóa / mở khóa theo đúng quy tắc của 2 chức năng riêng
    if (body.Status && body.Status !== user.Status) {
      update.Status = body.Status;
      if (body.Status === "active") {
        update.Failed_Login_Count = 0;
        update.Locked_Until = null;
      }
    }

    const updated = await User.findOneAndUpdate(
      { User_id: user.User_id, Role: MANAGED_ROLE },
      { $set: update },
      { new: true, runValidators: true }
    )
      .select(PUBLIC_FIELDS)
      .lean();

    if (!updated) return fail(res, 404, "Không tìm thấy nhân viên");

    logAction(req, update.Status ? `update+${update.Status}` : "update", updated);

    return res.json({
      success: true,
      message: "Cập nhật nhân viên thành công",
      data: toStaffItem(updated),
    });
  } catch (error) {
    if (error?.code === 11000) {
      return fail(res, 409, duplicateKeyMessage(error) || "Dữ liệu đã tồn tại trong hệ thống", duplicateKeyField(error));
    }

    console.error("updateStaff error:", error.message);
    return fail(res, 500, "Không thể cập nhật nhân viên");
  }
};

// PATCH /api/admin/staff/:userId/lock
// Khóa tài khoản: authMiddleware kiểm tra Status trong DB ở mọi request nên phiên đăng nhập
// hiện có của nhân viên bị chặn ngay (403 "Tài khoản đã bị khóa").
exports.lockStaff = async (req, res) => {
  try {
    const user = await loadManagedStaff(req, res);
    if (!user) return undefined;

    // Chuyển trạng thái nguyên tử: chỉ khóa khi chưa bị khóa
    const locked = await User.findOneAndUpdate(
      { User_id: user.User_id, Role: MANAGED_ROLE, Status: { $ne: "blocked" } },
      { $set: { Status: "blocked" } },
      { new: true }
    )
      .select(PUBLIC_FIELDS)
      .lean();

    if (!locked) return fail(res, 409, "Tài khoản đã ở trạng thái tạm khóa");

    logAction(req, "lock", locked);

    return res.json({
      success: true,
      message: "Đã khóa nhân viên",
      data: toStaffItem(locked),
    });
  } catch (error) {
    console.error("lockStaff error:", error.message);
    return fail(res, 500, "Không thể khóa nhân viên");
  }
};

// PATCH /api/admin/staff/:userId/unlock
exports.unlockStaff = async (req, res) => {
  try {
    const user = await loadManagedStaff(req, res);
    if (!user) return undefined;

    // Mở khóa: về trạng thái hoạt động, xóa bộ đếm đăng nhập sai / khóa tạm thời
    const unlocked = await User.findOneAndUpdate(
      { User_id: user.User_id, Role: MANAGED_ROLE, Status: "blocked" },
      { $set: { Status: "active", Failed_Login_Count: 0, Locked_Until: null } },
      { new: true }
    )
      .select(PUBLIC_FIELDS)
      .lean();

    if (!unlocked) return fail(res, 409, "Tài khoản đang hoạt động");

    logAction(req, "unlock", unlocked);

    return res.json({
      success: true,
      message: "Đã mở khóa nhân viên",
      data: toStaffItem(unlocked),
    });
  } catch (error) {
    console.error("unlockStaff error:", error.message);
    return fail(res, 500, "Không thể mở khóa nhân viên");
  }
};
