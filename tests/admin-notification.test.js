/**
 * BỘ KIỂM THỬ GIAI ĐOẠN 1: BACKEND NOTIFICATION CORE & RBAC
 * VISTA MANAGER <-> STAFF OPERATIONAL NOTIFICATION SYSTEM
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");

// Nạp cấu hình từ .env.test để kiểm thử an toàn trên database vista_test
dotenv.config({ path: "D:/VISTA/vista_api/.env.test" });

const Notification = require("../models/notification.model");
const { User } = require("../models/schema");
const adminRoutes = require("../routes/admin.routes");
const notificationRoutes = require("../routes/notification.routes");
const notificationService = require("../services/notification.service");

let server;
let baseUrl;
let managerToken;
let staffAToken;
let staffBToken;
let staffCToken;
let customerToken;
let expiredToken;

let managerUser;
let staffAUser;
let staffBUser;
let staffCUser;
let blockedStaffUser;
let customerUser;

// Helper gửi HTTP request
async function sendRequest({ url, method = "GET", token, body }) {
  const fullUrl = new URL(url, baseUrl);
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(fullUrl, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseText = await res.text();
  let json;
  try {
    json = JSON.parse(responseText);
  } catch (e) {
    json = { raw: responseText };
  }

  return { status: res.status, headers: res.headers, body: json };
}

test.before(async () => {
  // 1. Kết nối MongoDB
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  }

  // 2. Tìm tài khoản kiểm thử thực tế từ DB
  managerUser = await User.findOne({ Role: "Manager", Status: "active" });
  assert.ok(managerUser, "Phải có tài khoản Manager active");

  const staffList = await User.find({ Role: "Staff", Status: "active" }).limit(3);
  assert.ok(staffList.length >= 2, "Phải có ít nhất 2 tài khoản Staff active (Staff A & Staff B)");
  staffAUser = staffList[0];
  staffBUser = staffList[1];
  staffCUser = staffList[2] || null;

  blockedStaffUser = await User.findOne({ Role: "Staff", Status: "blocked" });
  customerUser = await User.findOne({ Role: "Customer" });

  // 3. Ký JWT Tokens
  managerToken = jwt.sign(
    { User_id: managerUser.User_id, Email: managerUser.Email, Role: "Manager" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  staffAToken = jwt.sign(
    { User_id: staffAUser.User_id, Email: staffAUser.Email, Role: "Staff" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  staffBToken = jwt.sign(
    { User_id: staffBUser.User_id, Email: staffBUser.Email, Role: "Staff" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  if (staffCUser) {
    staffCToken = jwt.sign(
      { User_id: staffCUser.User_id, Email: staffCUser.Email, Role: "Staff" },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
  }

  customerToken = customerUser
    ? jwt.sign(
        { User_id: customerUser.User_id, Email: customerUser.Email, Role: "Customer" },
        process.env.JWT_SECRET,
        { expiresIn: "1h" }
      )
    : null;

  expiredToken = jwt.sign(
    { User_id: managerUser.User_id, Email: managerUser.Email, Role: "Manager" },
    process.env.JWT_SECRET,
    { expiresIn: -10 }
  );

  // 4. Khởi tạo Express Test App
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRoutes);
  app.use("/api/notifications", notificationRoutes);

  server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  // Dọn dẹp các thông báo test đã sinh
  try {
    await Notification.deleteMany({ Title: { $regex: /^\[TEST\]/ } });
  } catch (e) {}

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

// =============================================================================
// PHẦN 1: KIỂM THỬ DISPATCH & VALIDATION (PHẦN 9.1)
// =============================================================================

test("1.1 Manager gửi thông báo đến toàn bộ Staff (all_staff) thành công", async () => {
  const payload = {
    title: "[TEST] Cảnh báo đơn hàng trễ SLA kho",
    message: "Yêu cầu toàn bộ nhân viên kho tập trung xử lý các đơn hàng đang quá hạn.",
    priority: "urgent",
    recipient_mode: "all_staff",
    confirm_resend: true,
  };

  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: payload,
  });

  assert.equal(res.status, 201, "Phải trả mã HTTP 201");
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.priority, "urgent");
  assert.equal(res.body.data.senderId, managerUser.User_id);
  assert.ok(res.body.data.recipients.length >= 2, "Recipients phải chứa toàn bộ staff đang hoạt động");

  // Kiểm tra lưu DB
  const doc = await Notification.findOne({ Notification_id: res.body.data.id });
  assert.ok(doc, "Phải tìm thấy thông báo trong MongoDB");
  assert.equal(doc.Audience, "staff_operational");
  assert.equal(doc.Sender_id, managerUser.User_id);
  assert.equal(doc.Priority, "urgent");
  assert.ok(doc.Recipients.every((r) => r.Status === "sent"), "Tất cả recipients ban đầu phải có Status: sent");
});

test("1.2 Manager gửi thông báo đến một Staff cụ thể (specific_staff) thành công", async () => {
  const payload = {
    title: "[TEST] Nhắc nhở xử lý yêu cầu hoàn trả",
    message: "Vui lòng kiểm tra và duyệt yêu cầu hoàn trả đơn DEMO_RET_006.",
    priority: "important",
    recipient_mode: "specific_staff",
    recipient_ids: [staffAUser.User_id],
    target_entity: {
      entity_type: "return",
      entity_id: "DEMO_RET_006",
    },
    confirm_resend: true,
  };

  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: payload,
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.priority, "important");
  assert.equal(res.body.data.recipients.length, 1);
  assert.equal(res.body.data.recipients[0].userId, staffAUser.User_id);
  assert.equal(res.body.data.recipients[0].status, "sent");
});

test("1.3 Chặn gửi thông báo khi thiếu tiêu đề (HTTP 400)", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      message: "Nội dung hợp lệ nhưng thiếu tiêu đề.",
      recipient_mode: "all_staff",
    },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.field, "title");
});

test("1.4 Chặn gửi thông báo khi thiếu nội dung (HTTP 400)", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Tiêu đề hợp lệ",
      message: "   ",
      recipient_mode: "all_staff",
    },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.field, "message");
});

test("1.5 Chặn gửi Priority không hợp lệ (HTTP 400)", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Tiêu đề kiểm tra",
      message: "Nội dung thông báo kiểm tra.",
      priority: "extreme_danger_fake",
      recipient_mode: "all_staff",
    },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.field, "priority");
});

test("1.6 Chặn gửi recipient_mode không hợp lệ (HTTP 400)", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Tiêu đề kiểm tra",
      message: "Nội dung thông báo kiểm tra.",
      recipient_mode: "random_department",
    },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.field, "recipient_mode");
});

test("1.7 Chặn gửi tới Staff không tồn tại (HTTP 400)", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Tiêu đề kiểm tra",
      message: "Nội dung thông báo kiểm tra.",
      recipient_mode: "specific_staff",
      recipient_ids: ["USR_NON_EXISTENT_99999"],
    },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.field, "recipient_ids");
});

test("1.8 Chặn gửi tới tài khoản không phải Staff (ví dụ Manager khác) (HTTP 400)", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Tiêu đề kiểm tra",
      message: "Nội dung thông báo kiểm tra.",
      recipient_mode: "specific_staff",
      recipient_ids: [managerUser.User_id],
    },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.field, "recipient_ids");
});

test("1.9 Chặn gửi tới tài khoản Staff đang bị khóa (blocked) (HTTP 400)", async () => {
  if (!blockedStaffUser) return;

  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Tiêu đề kiểm tra",
      message: "Nội dung thông báo kiểm tra.",
      recipient_mode: "specific_staff",
      recipient_ids: [blockedStaffUser.User_id],
    },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.field, "recipient_ids");
});

test("1.10 Danh sách recipient_ids trùng lặp được tự động gộp (deduplicate)", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Kiểm tra gộp mã nhân viên trùng",
      message: "Nội dung kiểm tra trùng lặp người nhận.",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id, staffAUser.User_id, staffAUser.User_id],
      confirm_resend: true,
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.recipients.length, 1, "Recipients chỉ được chứa 1 bản ghi duy nhất cho Staff A");
});

// =============================================================================
// PHẦN 2: KIỂM THỬ RBAC & BẢO MẬT (PHẦN 9.2)
// =============================================================================

test("2.1 Staff gọi API dispatch -> Bị chặn HTTP 403 Forbidden", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: staffAToken,
    body: {
      title: "[TEST] Staff cố tình phát cảnh báo",
      message: "Nội dung giả mạo quyền Manager.",
      recipient_mode: "all_staff",
    },
  });

  assert.equal(res.status, 403, "Staff tuyệt đối không có quyền gọi dispatch");
  assert.equal(res.body.success, false);
});

test("2.2 Customer gọi API dispatch -> Bị chặn HTTP 403 Forbidden", async () => {
  if (!customerToken) return;

  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: customerToken,
    body: {
      title: "[TEST] Khách hàng cố tình phát cảnh báo",
      message: "Nội dung thử tấn công phân quyền.",
      recipient_mode: "all_staff",
    },
  });

  assert.equal(res.status, 403);
  assert.equal(res.body.success, false);
});

test("2.3 Request không có JWT Token -> Bị chặn HTTP 401 Unauthorized", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    body: {
      title: "[TEST] Không có token",
      message: "Nội dung kiểm tra token.",
      recipient_mode: "all_staff",
    },
  });

  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test("2.4 Request có JWT Token hết hạn -> Bị chặn HTTP 401 Unauthorized", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: expiredToken,
    body: {
      title: "[TEST] Token hết hạn",
      message: "Nội dung kiểm tra token hết hạn.",
      recipient_mode: "all_staff",
    },
  });

  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test("2.5 Backend tự xác định Sender từ JWT, bỏ qua Sender_id giả mạo trong body", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Giả mạo sender",
      message: "Nội dung thử nghiệm sender_id giả mạo.",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id],
      sender_id: "USR_HACKER_FORGED",
      sender_name: "Hacker Mạo Danh",
      confirm_resend: true,
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.senderId, managerUser.User_id, "Sender_id phải lấy từ JWT của Manager");
  assert.notEqual(res.body.data.senderId, "USR_HACKER_FORGED");
});

test("2.6 Manager không được phép acknowledge thông báo vận hành (Bị chặn HTTP 403)", async () => {
  // 1. Tạo thông báo vận hành hợp lệ có Staff nằm trong Recipients
  const dispatchRes = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Cảnh báo kiểm thử quyền Manager Acknowledge",
      message: "Nhiệm vụ giao cho Staff A và Staff B.",
      priority: "important",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id, staffBUser.User_id],
      confirm_resend: true,
    },
  });

  assert.equal(dispatchRes.status, 201);
  const notificationId = dispatchRes.body.data.id;

  // 2. Manager gọi PATCH /api/admin/notifications/:id/acknowledge
  const ackRes = await sendRequest({
    url: `/api/admin/notifications/${notificationId}/acknowledge`,
    method: "PATCH",
    token: managerToken,
  });

  // 3. Xác nhận API trả về HTTP 403 Forbidden
  assert.equal(ackRes.status, 403, "Manager gọi acknowledge phải bị từ chối 403 Forbidden");
  assert.equal(ackRes.body.success, false);

  // 4. Truy vấn lại Notification trong database
  const doc = await Notification.findOne({ Notification_id: notificationId });
  assert.ok(doc, "Thông báo phải tồn tại trong MongoDB");

  // 5. Xác nhận trạng thái của tất cả Staff trong Recipients không bị thay đổi (vẫn là 'sent')
  for (const recipient of doc.Recipients) {
    assert.equal(
      recipient.Status,
      "sent",
      `Trạng thái của ${recipient.User_id} không được thay đổi bởi hành động của Manager`
    );
    // 6. Xác nhận Acknowledged_at không bị cập nhật (vẫn là null)
    assert.equal(
      recipient.Acknowledged_at,
      null,
      `Acknowledged_at của ${recipient.User_id} bắt buộc phải là null`
    );
  }
});

// =============================================================================
// PHẦN 3: KIỂM THỬ TRẠNG THÁI RIÊNG CHO TỪNG STAFF (PHẦN 9.3)
// =============================================================================

test("3.1 Tính độc lập trạng thái: Staff A tiếp nhận KHÔNG làm thay đổi trạng thái của Staff B", async () => {
  // 1. Manager gửi thông báo cho cả Staff A và Staff B
  const dispatchRes = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Kiểm thử trạng thái độc lập",
      message: "Giao việc đồng thời cho Staff A và Staff B.",
      priority: "urgent",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id, staffBUser.User_id],
      confirm_resend: true,
    },
  });

  assert.equal(dispatchRes.status, 201);
  const notificationId = dispatchRes.body.data.id;

  // Kiểm tra ban đầu trong DB: cả 2 đều là 'sent'
  let doc = await Notification.findOne({ Notification_id: notificationId });
  let recA = doc.Recipients.find((r) => r.User_id === staffAUser.User_id);
  let recB = doc.Recipients.find((r) => r.User_id === staffBUser.User_id);
  assert.equal(recA.Status, "sent");
  assert.equal(recA.Acknowledged_at, null);
  assert.equal(recB.Status, "sent");
  assert.equal(recB.Acknowledged_at, null);

  // 2. Staff A bấm Tiếp nhận (Acknowledge)
  const ackResA = await sendRequest({
    url: `/api/admin/notifications/${notificationId}/acknowledge`,
    method: "PATCH",
    token: staffAToken,
  });

  assert.equal(ackResA.status, 200);
  assert.equal(ackResA.body.success, true);
  assert.equal(ackResA.body.data.status, "acknowledged");
  assert.ok(ackResA.body.data.acknowledgedAt);

  // 3. Kiểm tra DB sau khi A tiếp nhận: A = acknowledged, B VẪN LÀ sent!
  doc = await Notification.findOne({ Notification_id: notificationId });
  recA = doc.Recipients.find((r) => r.User_id === staffAUser.User_id);
  recB = doc.Recipients.find((r) => r.User_id === staffBUser.User_id);
  assert.equal(recA.Status, "acknowledged", "Staff A phải chuyển sang acknowledged");
  assert.ok(recA.Acknowledged_at, "Staff A phải có thời điểm tiếp nhận");
  assert.equal(recB.Status, "sent", "Staff B BẮT BUỘC VẪN PHẢI LÀ 'sent'");
  assert.equal(recB.Acknowledged_at, null, "Staff B chưa tiếp nhận nên Acknowledged_at phải null");

  // 4. Staff B bấm Tiếp nhận sau đó
  const ackResB = await sendRequest({
    url: `/api/admin/notifications/${notificationId}/acknowledge`,
    method: "PATCH",
    token: staffBToken,
  });

  assert.equal(ackResB.status, 200);
  assert.equal(ackResB.body.data.status, "acknowledged");

  // Kiểm tra DB: cả 2 giờ đều đã acknowledged với thời gian riêng biệt
  doc = await Notification.findOne({ Notification_id: notificationId });
  recA = doc.Recipients.find((r) => r.User_id === staffAUser.User_id);
  recB = doc.Recipients.find((r) => r.User_id === staffBUser.User_id);
  assert.equal(recA.Status, "acknowledged");
  assert.equal(recB.Status, "acknowledged");
});

test("3.2 Staff A không thể tiếp nhận thông báo gửi riêng cho Staff B (HTTP 403)", async () => {
  // Gửi riêng cho Staff B
  const dispatchRes = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Gửi riêng cho Staff B",
      message: "Chỉ Staff B được nhận và tiếp nhận việc này.",
      recipient_mode: "specific_staff",
      recipient_ids: [staffBUser.User_id],
      confirm_resend: true,
    },
  });

  const notificationId = dispatchRes.body.data.id;

  // Staff A cố tình gọi acknowledge
  const res = await sendRequest({
    url: `/api/admin/notifications/${notificationId}/acknowledge`,
    method: "PATCH",
    token: staffAToken,
  });

  assert.equal(res.status, 403, "Staff không thuộc recipients phải bị từ chối 403");
  assert.equal(res.body.success, false);
});

test("3.3 Acknowledge lần 2 là Idempotent (không ghi đè thời gian tiếp nhận ban đầu)", async () => {
  // Tạo thông báo cho Staff A
  const dispatchRes = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Kiểm thử idempotent acknowledge",
      message: "Nội dung kiểm thử.",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id],
      confirm_resend: true,
    },
  });

  const notificationId = dispatchRes.body.data.id;

  // Lần 1: acknowledge
  const firstAck = await sendRequest({
    url: `/api/admin/notifications/${notificationId}/acknowledge`,
    method: "PATCH",
    token: staffAToken,
  });
  assert.equal(firstAck.status, 200);
  const firstAckTime = new Date(firstAck.body.data.acknowledgedAt).getTime();

  // Chờ 50ms
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Lần 2: gọi lại
  const secondAck = await sendRequest({
    url: `/api/admin/notifications/${notificationId}/acknowledge`,
    method: "PATCH",
    token: staffAToken,
  });

  assert.equal(secondAck.status, 200);
  assert.equal(secondAck.body.alreadyAcknowledged, true);
  const secondAckTime = new Date(secondAck.body.data.acknowledgedAt).getTime();
  assert.equal(secondAckTime, firstAckTime, "Thời gian tiếp nhận ban đầu không được bị ghi đè");
});

// =============================================================================
// PHẦN 4: KIỂM THỬ TRUY VẤN & TÍNH RIÊNG TƯ (PHẦN 9.4)
// =============================================================================

test("4.1 Staff chỉ thấy thông báo được giao cho mình trong GET /api/admin/notifications/assigned", async () => {
  // Gửi riêng cho Staff B
  await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: {
      title: "[TEST] Nhiệm vụ tuyệt mật chỉ cho Staff B",
      message: "Nội dung bí mật.",
      recipient_mode: "specific_staff",
      recipient_ids: [staffBUser.User_id],
      confirm_resend: true,
    },
  });

  // Staff A truy vấn danh sách thông báo được giao
  const resStaffA = await sendRequest({
    url: "/api/admin/notifications/assigned",
    method: "GET",
    token: staffAToken,
  });

  assert.equal(resStaffA.status, 200);
  const items = resStaffA.body.data.items;
  const foundSecret = items.find((item) => item.title === "[TEST] Nhiệm vụ tuyệt mật chỉ cho Staff B");
  assert.equal(foundSecret, undefined, "Staff A TUYỆT ĐỐI KHÔNG được thấy thông báo gửi riêng cho Staff B");
});

test("4.2 Manager xem được lịch sử đã gửi kèm danh sách người nhận trong GET /api/admin/notifications/sent", async () => {
  const res = await sendRequest({
    url: "/api/admin/notifications/sent",
    method: "GET",
    token: managerToken,
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data.items));
  assert.ok(res.body.data.pagination);

  const sampleItem = res.body.data.items.find((item) => item.senderId === managerUser.User_id);
  if (sampleItem) {
    assert.ok(sampleItem.recipients, "Manager phải xem được danh sách recipients");
    assert.ok(typeof sampleItem.recipientCount === "number");
    assert.ok(typeof sampleItem.acknowledgedCount === "number");
  }
});

test("4.3 Tích hợp chuông thông báo (Bell): Staff gọi GET /api/notifications thấy cả thông báo vận hành của mình", async () => {
  const res = await sendRequest({
    url: "/api/notifications",
    method: "GET",
    token: staffAToken,
  });

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.data.items));
  assert.ok(typeof res.body.data.unreadCount === "number");
});

// =============================================================================
// PHẦN 5: KIỂM SOÁT GỬI TRÙNG & IDEMPOTENCY (PHẦN 9.5)
// =============================================================================

test("5.1 Gửi cùng Idempotency Key -> Trả về bản ghi đã tạo, không tạo mới (HTTP 200 / isDuplicate: true)", async () => {
  const testKey = `IDEM_KEY_${Date.now()}`;
  const payload = {
    title: "[TEST] Thử nghiệm Idempotency",
    message: "Nội dung chỉ gửi đúng 1 lần.",
    recipient_mode: "specific_staff",
    recipient_ids: [staffAUser.User_id],
    idempotency_key: testKey,
    confirm_resend: true,
  };

  // Lần 1
  const res1 = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: payload,
  });
  assert.equal(res1.status, 201);
  assert.equal(res1.body.isDuplicate, false);
  const firstId = res1.body.data.id;

  // Lần 2 (ngay sau đó với cùng key)
  const res2 = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: payload,
  });
  assert.equal(res2.status, 200);
  assert.equal(res2.body.isDuplicate, true);
  assert.equal(res2.body.data.id, firstId, "Phải trả về đúng mã thông báo ban đầu");
});

test("5.2 Gửi thông báo lặp trong 60 giây không có confirm_resend -> Bị từ chối HTTP 409 Conflict", async () => {
  const uniqueTitle = `[TEST] Cảnh báo trùng lặp ${Date.now()}`;
  const payload = {
    title: uniqueTitle,
    message: "Yêu cầu xử lý nhanh.",
    recipient_mode: "specific_staff",
    recipient_ids: [staffAUser.User_id],
    confirm_resend: false,
  };

  // Lần 1: thành công
  const res1 = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: payload,
  });
  assert.equal(res1.status, 201);

  // Lần 2: gửi lại cùng tiêu đề ngay lập tức không có confirm_resend
  const res2 = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: payload,
  });

  assert.equal(res2.status, 409, "Phải trả lỗi HTTP 409 Conflict để cảnh báo gửi trùng");
  assert.equal(res2.body.code, "DUPLICATE_RECENT_ALERT");

  // Lần 3: có confirm_resend -> Được phép gửi
  const res3 = await sendRequest({
    url: "/api/admin/notifications/dispatch",
    method: "POST",
    token: managerToken,
    body: { ...payload, confirm_resend: true },
  });
  assert.equal(res3.status, 201, "Khi Manager xác nhận confirm_resend thì cho phép tạo tiếp");
});

// =============================================================================
// PHẦN 6: REGRESSION TESTS (HỆ THỐNG THÔNG BÁO CŨ VẪN HOẠT ĐỘNG) (PHẦN 9.6)
// =============================================================================

test("6.1 Regression: createNotification gửi khách hàng (Audience: customer) hoạt động bình thường", async () => {
  const doc = await notificationService.createNotification({
    audience: "customer",
    userId: customerUser ? customerUser.User_id : "CUST_TEST_01",
    type: "order_created",
    title: "[TEST] Đặt hàng thành công",
    message: "Đơn hàng của bạn đã được ghi nhận.",
    orderId: "DEMO_ORD_TEST",
  });

  assert.ok(doc);
  assert.equal(doc.Audience, "customer");
  assert.equal(doc.Type, "order_created");

  const client = notificationService.toClient(doc.toObject(), customerUser?.User_id);
  assert.equal(client.type, "order_created");
  assert.equal(client.orderId, "DEMO_ORD_TEST");
  assert.equal(client.isRead, false);
});

test("6.2 Regression: createNotification gửi ban quản trị (Audience: admin) hoạt động bình thường", async () => {
  const doc = await notificationService.createNotification({
    audience: "admin",
    type: "sla_confirm_overdue",
    title: "[TEST] Đơn quá hạn xác nhận",
    message: "#DEMO_ORD_TEST · đã chờ xác nhận hơn 2 giờ",
    orderId: "DEMO_ORD_TEST",
  });

  assert.ok(doc);
  assert.equal(doc.Audience, "admin");
  assert.equal(doc.Type, "sla_confirm_overdue");
});

test("6.3 Regression: PATCH /api/notifications/:id/read đánh dấu đã đọc hoạt động bình thường", async () => {
  const testNotif = await Notification.create({
    Notification_id: `NTF_TEST_READ_${Date.now()}`,
    Audience: "admin",
    Type: "test_read",
    Title: "[TEST] Kiểm thử đánh dấu đã đọc",
    Message: "Thông báo kiểm thử.",
    Read_by: [],
  });

  const res = await sendRequest({
    url: `/api/notifications/${testNotif.Notification_id}/read`,
    method: "PATCH",
    token: managerToken,
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);

  const updated = await Notification.findOne({ Notification_id: testNotif.Notification_id });
  assert.ok(updated.Read_by.includes(managerUser.User_id), "Mã manager phải có trong Read_by");
});
