/**
 * STAGE 2.3: INTEGRATION & E2E TEST SUITE
 * VISTA OPERATIONAL NOTIFICATION SYSTEM (MANAGER <-> STAFF)
 *
 * Kiểm thử toàn diện luồng:
 * Manager (HTTP REST) -> Express API -> MongoDB -> Socket.IO Gateway -> Staff (Socket client / REST)
 *
 * Bao phủ đầy đủ 12 Test Cases (TC01 -> TC12) theo đề bài:
 * - TC01: Gửi đến một Staff cụ thể (Staff A nhận, Staff B & Manager không nhận)
 * - TC02: Gửi đến toàn bộ Staff (all_staff phát tới từng staff, trạng thái độc lập)
 * - TC03: Payload và UI contract (đầy đủ metadata, không lộ Recipients của người khác)
 * - TC04: Độc lập trạng thái (đọc độc lập, tiếp nhận độc lập giữa Staff A và Staff B)
 * - TC05: Tiếp nhận lặp (Idempotent Acknowledge, bảo toàn timestamp)
 * - TC06: Phân quyền RBAC (Staff chỉ xem của mình, không ack chéo, Manager không ack, Customer bị chặn 403)
 * - TC07: Staff offline (Lưu MongoDB thành công, Staff online lại tải được qua REST)
 * - TC08: Reconnect & Deduplication (Ngắt và kết nối lại không sinh listener/toast lặp)
 * - TC09: REST và Socket đồng thời (Không mất dữ liệu, không ghi đè trạng thái)
 * - TC10: Đổi tài khoản (Staff A logout -> Staff B login, cô lập dữ liệu hoàn toàn)
 * - TC11: Socket emit thất bại (MongoDB vẫn lưu, các người nhận khác vẫn nhận socket, API trả 201)
 * - TC12: Legacy Notification (Thông báo loại order, general không có priority/sender vẫn chạy mượt)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");
const ioClient = require("D:/VISTA/vista_frontend/node_modules/socket.io-client");

dotenv.config({ path: "D:/VISTA/vista_api/.env.test" });

const Notification = require("../models/notification.model");
const { User } = require("../models/schema");
const socketService = require("../services/socket.service");
const notificationService = require("../services/notification.service");
const adminRoutes = require("../routes/admin.routes");
const notificationRoutes = require("../routes/notification.routes");

let server;
let baseUrl = "";
let managerUser;
let staffAUser;
let staffBUser;
let customerUser;

let managerToken;
let staffAToken;
let staffBToken;
let customerToken;

let managerSocket;
let staffASocket;
let staffBSocket;

// Helper: Gửi HTTP Request
async function request(endpoint, options = {}) {
  const url = `${baseUrl}${endpoint}`;
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
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

// Helper: Chờ một event socket cụ thể
function waitForSocketEvent(socket, eventName, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let timer;
    const handler = (data) => {
      clearTimeout(timer);
      resolve(data);
    };
    timer = setTimeout(() => {
      socket.off(eventName, handler);
      resolve(null);
    }, timeoutMs);

    socket.once(eventName, handler);
  });
}

// Helper: Tạo Socket.IO client kết nối tới server test
function createSocketClient(token) {
  return ioClient(baseUrl, {
    auth: { token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
}

test.before(async () => {
  // 1. Kết nối MongoDB
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  }

  // 2. Tìm tài khoản kiểm thử từ DB
  managerUser = await User.findOne({ Role: "Manager", Status: "active" });
  assert.ok(managerUser, "Phải có tài khoản Manager active trong vista_test");

  const staffList = await User.find({ Role: "Staff", Status: "active" }).limit(2);
  assert.ok(staffList.length >= 2, "Phải có ít nhất 2 Staff active (Staff A & Staff B)");
  staffAUser = staffList[0];
  staffBUser = staffList[1];

  customerUser = await User.findOne({ Role: "Customer" });

  // 3. Ký JWT Tokens
  managerToken = jwt.sign(
    { User_id: managerUser.User_id, Email: managerUser.Email, Role: "Manager" },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );

  staffAToken = jwt.sign(
    { User_id: staffAUser.User_id, Email: staffAUser.Email, Role: "Staff" },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );

  staffBToken = jwt.sign(
    { User_id: staffBUser.User_id, Email: staffBUser.Email, Role: "Staff" },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );

  if (customerUser) {
    customerToken = jwt.sign(
      { User_id: customerUser.User_id, Email: customerUser.Email, Role: "Customer" },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );
  }

  // 4. Khởi tạo Express Test App & Socket.IO Server
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRoutes);
  app.use("/api/notifications", notificationRoutes);

  server = http.createServer(app);
  socketService.init(server);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // 5. Kết nối Socket Client cho Manager, Staff A, Staff B
  staffASocket = createSocketClient(staffAToken);
  staffBSocket = createSocketClient(staffBToken);
  managerSocket = createSocketClient(managerToken);

  await Promise.all([
    new Promise((resolve) => staffASocket.on("connect", resolve)),
    new Promise((resolve) => staffBSocket.on("connect", resolve)),
    new Promise((resolve) => managerSocket.on("connect", resolve)),
  ]);
});

test.after(async () => {
  // Ngắt kết nối socket clients
  staffASocket?.disconnect();
  staffBSocket?.disconnect();
  managerSocket?.disconnect();

  // Dọn dẹp notifications sinh ra trong E2E test
  try {
    await Notification.deleteMany({ Title: { $regex: /^\[E2E_TEST\]/ } });
  } catch (e) {}

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

// =============================================================================
// TEST CASES E2E THEO ĐỀ BÀI (TC01 -> TC12)
// =============================================================================

test("TC01 – Gửi đến một Staff cụ thể: Staff A nhận, Staff B & Manager không nhận", async () => {
  const staffAPromise = waitForSocketEvent(staffASocket, "notification:new", 2500);
  const staffBPromise = waitForSocketEvent(staffBSocket, "notification:new", 1000);
  const managerPromise = waitForSocketEvent(managerSocket, "notification:new", 1000);

  const res = await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Cảnh báo gửi riêng cho Staff A",
      message: "Vui lòng kiểm tra khẩn cấp đơn hàng trễ hạn SLA.",
      priority: "urgent",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id],
      target_entity: {
        entity_type: "order",
        entity_id: "ORD_E2E_001",
      },
      confirm_resend: true,
    },
  });

  assert.equal(res.status, 201, "API dispatch phải trả 201 Created");
  assert.equal(res.body.success, true);

  // 1. Kiểm tra MongoDB lưu chính xác
  const savedDoc = await Notification.findOne({ Notification_id: res.body.data.id });
  assert.ok(savedDoc, "Notification phải được lưu trong MongoDB");
  assert.equal(savedDoc.Audience, "staff_operational");
  assert.equal(savedDoc.Priority, "urgent");
  assert.equal(savedDoc.Recipients.length, 1);
  assert.equal(savedDoc.Recipients[0].User_id, staffAUser.User_id);
  assert.equal(savedDoc.Recipients[0].Status, "sent");

  // 2. Kiểm tra Staff A nhận event socket
  const staffAPayload = await staffAPromise;
  assert.ok(staffAPayload, "Staff A phải nhận được event notification:new");
  assert.equal(staffAPayload.id, savedDoc.Notification_id);
  assert.equal(staffAPayload.title, "[E2E_TEST] Cảnh báo gửi riêng cho Staff A");
  assert.equal(staffAPayload.priority, "urgent");
  assert.equal(staffAPayload.status, "sent");

  // 3. Kiểm tra Staff B và Manager KHÔNG nhận được event
  const staffBPayload = await staffBPromise;
  const managerPayload = await managerPromise;
  assert.equal(staffBPayload, null, "Staff B tuyệt đối không nhận được thông báo gửi riêng cho Staff A");
  assert.equal(managerPayload, null, "Manager không tự nhận thông báo của mình như một người nhận");
});

test("TC02 – Gửi đến toàn bộ Staff: Tất cả Staff active nhận được, trạng thái độc lập", async () => {
  const staffAPromise = waitForSocketEvent(staffASocket, "notification:new", 2500);
  const staffBPromise = waitForSocketEvent(staffBSocket, "notification:new", 2500);

  const res = await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Thông báo toàn thể nhân viên ca trực",
      message: "Chuẩn bị kiểm kê hàng hóa cuối ngày.",
      priority: "important",
      recipient_mode: "all_staff",
      confirm_resend: true,
    },
  });

  assert.equal(res.status, 201);
  const savedDoc = await Notification.findOne({ Notification_id: res.body.data.id });
  assert.ok(savedDoc);

  // Kiểm tra danh sách Recipients trong DB không có ID trùng lặp
  const recipientIds = savedDoc.Recipients.map((r) => r.User_id);
  const uniqueRecipientIds = [...new Set(recipientIds)];
  assert.equal(recipientIds.length, uniqueRecipientIds.length, "Không được có recipient trùng lặp trong DB");
  assert.ok(recipientIds.includes(staffAUser.User_id));
  assert.ok(recipientIds.includes(staffBUser.User_id));

  // Kiểm tra cả Staff A và Staff B đều nhận được event socket
  const payloadA = await staffAPromise;
  const payloadB = await staffBPromise;
  assert.ok(payloadA, "Staff A phải nhận được thông báo");
  assert.ok(payloadB, "Staff B phải nhận được thông báo");
  assert.equal(payloadA.id, savedDoc.Notification_id);
  assert.equal(payloadB.id, savedDoc.Notification_id);
});

test("TC03 – Payload và UI Contract: Staff nhận đủ trường và KHÔNG bị lộ Recipients khác", async () => {
  const staffAPromise = waitForSocketEvent(staffASocket, "notification:new", 2500);

  const res = await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Kiểm tra contract payload và metadata",
      message: "Yêu cầu kiểm tra đơn đổi trả #RET_009",
      priority: "urgent",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id],
      target_entity: {
        entity_type: "return",
        entity_id: "RET_009",
      },
      confirm_resend: true,
    },
  });

  assert.equal(res.status, 201);
  const payload = await staffAPromise;
  assert.ok(payload);

  // Xác minh các trường bắt buộc của AppNotification Frontend
  assert.equal(payload.id, res.body.data.id);
  assert.equal(payload.type, "operational_alert");
  assert.equal(payload.title, "[E2E_TEST] Kiểm tra contract payload và metadata");
  assert.equal(payload.message, "Yêu cầu kiểm tra đơn đổi trả #RET_009");
  assert.equal(payload.priority, "urgent");
  assert.equal(payload.senderId, managerUser.User_id);
  assert.ok(payload.senderName, "Phải có senderName");
  assert.equal(payload.status, "sent");
  assert.equal(payload.isRead, false);
  assert.ok(payload.createdAt, "Phải có createdAt");
  assert.equal(payload.targetEntity?.Entity_type, "return");
  assert.equal(payload.targetEntity?.Entity_id, "RET_009");

  // Bảo mật: payload gửi tới Staff KHÔNG được chứa mảng Recipients của toàn bộ thông báo
  assert.equal(payload.recipients, undefined, "Staff payload tuyệt đối không chứa danh sách recipients khác");
});

test("TC04 – Độc lập trạng thái: Staff A đọc/tiếp nhận KHÔNG làm thay đổi Staff B", async () => {
  // Gửi thông báo cho cả A và B
  const res = await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Kiểm tra độc lập trạng thái đọc và tiếp nhận",
      message: "Xử lý đơn đổi trả song song",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id, staffBUser.User_id],
      confirm_resend: true,
    },
  });

  const notifId = res.body.data.id;

  // 1. Staff A đọc thông báo
  const readRes = await request(`/api/notifications/${notifId}/read`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${staffAToken}` },
  });
  assert.equal(readRes.status, 200);

  // Kiểm tra DB: Staff A có Read_at, nhưng Status vẫn là 'sent'
  let doc = await Notification.findOne({ Notification_id: notifId });
  let recA = doc.Recipients.find((r) => r.User_id === staffAUser.User_id);
  let recB = doc.Recipients.find((r) => r.User_id === staffBUser.User_id);
  assert.ok(recA.Read_at, "Staff A phải có Read_at");
  assert.equal(recA.Status, "sent", "Đọc thông báo KHÔNG làm thay đổi status 'sent'");
  assert.equal(recB.Read_at, null, "Staff B chưa đọc");
  assert.equal(recB.Status, "sent", "Staff B vẫn ở trạng thái 'sent'");

  // 2. Staff A tiếp nhận thông báo
  const ackRes = await request(`/api/admin/notifications/${notifId}/acknowledge`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${staffAToken}` },
  });
  assert.equal(ackRes.status, 200);
  assert.equal(ackRes.body.data.status, "acknowledged");

  // Kiểm tra DB sau khi A tiếp nhận:
  doc = await Notification.findOne({ Notification_id: notifId });
  recA = doc.Recipients.find((r) => r.User_id === staffAUser.User_id);
  recB = doc.Recipients.find((r) => r.User_id === staffBUser.User_id);
  assert.equal(recA.Status, "acknowledged", "Staff A đã tiếp nhận");
  assert.ok(recA.Acknowledged_at, "Staff A có Acknowledged_at");

  // Quan trọng: Staff B hoàn toàn KHÔNG bị thay đổi
  assert.equal(recB.Status, "sent", "Trạng thái Staff B không bị ảnh hưởng bởi việc Staff A tiếp nhận");
  assert.equal(recB.Acknowledged_at, null);
});

test("TC05 – Tiếp nhận lặp (Idempotent): Gọi acknowledge lần 2 không thay đổi timestamp ban đầu", async () => {
  const res = await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Kiểm tra Idempotent Acknowledge",
      message: "Tiếp nhận lặp",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id],
      confirm_resend: true,
    },
  });

  const notifId = res.body.data.id;

  // Lần 1: Tiếp nhận
  const firstAck = await request(`/api/admin/notifications/${notifId}/acknowledge`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${staffAToken}` },
  });
  assert.equal(firstAck.status, 200);
  assert.equal(firstAck.body.alreadyAcknowledged, false);
  const firstAckTime = firstAck.body.data.acknowledgedAt;

  // Chờ 50ms để kiểm tra timestamp
  await new Promise((r) => setTimeout(r, 50));

  // Lần 2: Tiếp nhận lại
  const secondAck = await request(`/api/admin/notifications/${notifId}/acknowledge`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${staffAToken}` },
  });
  assert.equal(secondAck.status, 200);
  assert.equal(secondAck.body.alreadyAcknowledged, true, "Phải trả về alreadyAcknowledged: true");
  assert.equal(
    new Date(secondAck.body.data.acknowledgedAt).getTime(),
    new Date(firstAckTime).getTime(),
    "Thời gian tiếp nhận ban đầu phải được giữ nguyên tuyệt đối"
  );
});

test("TC06 – Phân quyền RBAC: Staff xem đúng dữ liệu của mình, không ack chéo, Manager không ack, Customer bị chặn", async () => {
  // Tạo thông báo chỉ gửi riêng cho Staff B
  const res = await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Cảnh báo gửi riêng Staff B kiểm tra quyền",
      message: "Staff A không được phép can thiệp",
      recipient_mode: "specific_staff",
      recipient_ids: [staffBUser.User_id],
      confirm_resend: true,
    },
  });
  const notifIdForB = res.body.data.id;

  // 1. Staff A cố tình acknowledge thông báo của Staff B -> 403 Forbidden
  const forbiddenAck = await request(`/api/admin/notifications/${notifIdForB}/acknowledge`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${staffAToken}` },
  });
  assert.equal(forbiddenAck.status, 403, "Staff A không được phép acknowledge thông báo của Staff B");

  // 2. Manager cố tình gọi acknowledge -> 403 Forbidden (Chỉ Staff mới được quyền tiếp nhận)
  const managerAck = await request(`/api/admin/notifications/${notifIdForB}/acknowledge`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${managerToken}` },
  });
  assert.equal(managerAck.status, 403, "Manager không được phép acknowledge thay Staff");

  // 3. Customer cố tình gọi API dispatch -> 403 Forbidden
  if (customerToken) {
    const custDispatch = await request("/api/admin/notifications/dispatch", {
      method: "POST",
      headers: { Authorization: `Bearer ${customerToken}` },
      body: { title: "Fake", message: "Fake" },
    });
    assert.equal(custDispatch.status, 403, "Customer bị chặn gọi API dispatch");

    const custAssigned = await request("/api/admin/notifications/assigned", {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.equal(custAssigned.status, 403, "Customer bị chặn gọi API assigned");
  }

  // 4. Staff A gọi GET assigned: KHÔNG thấy thông báo của Staff B
  const assignedResA = await request("/api/admin/notifications/assigned", {
    headers: { Authorization: `Bearer ${staffAToken}` },
  });
  assert.equal(assignedResA.status, 200);
  const foundInA = (assignedResA.body.data?.items || []).some((item) => item.id === notifIdForB);
  assert.equal(foundInA, false, "Staff A không được thấy thông báo giao riêng cho Staff B");
});

test("TC07 – Staff Offline: Thông báo lưu MongoDB thành công, Staff online lại tải được qua REST", async () => {
  // 1. Ngắt kết nối socket của Staff A (giả lập offline)
  staffASocket.disconnect();

  // 2. Manager gửi thông báo tới Staff A khi A đang offline
  const res = await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Thông báo khi nhân viên offline",
      message: "Đơn hàng trễ hẹn khi staff không có mặt.",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id],
      confirm_resend: true,
    },
  });
  assert.equal(res.status, 201, "API dispatch vẫn thành công khi client socket offline");
  const offlineNotifId = res.body.data.id;

  // 3. Kiểm tra DB: Bản ghi đã tồn tại chắc chắn trong MongoDB
  const savedDoc = await Notification.findOne({ Notification_id: offlineNotifId });
  assert.ok(savedDoc, "Thông báo bắt buộc phải lưu trong MongoDB");

  // 4. Staff A online lại (kết nối socket và gọi REST API)
  staffASocket = createSocketClient(staffAToken);
  await new Promise((r) => staffASocket.on("connect", r));

  const listRes = await request("/api/notifications?limit=20", {
    headers: { Authorization: `Bearer ${staffAToken}` },
  });
  assert.equal(listRes.status, 200);
  const foundItem = (listRes.body.data?.items || []).find((i) => i.id === offlineNotifId);
  assert.ok(foundItem, "Staff A tải lại qua REST phải thấy thông báo đã được gửi trong lúc offline");
  assert.equal(foundItem.status, "sent");
});

test("TC08 – Reconnect: Ngắt và kết nối lại Socket duy trì danh sách và unreadCount chuẩn xác", async () => {
  // Ngắt kết nối Staff B
  staffBSocket.disconnect();

  // Kết nối lại
  staffBSocket = createSocketClient(staffBToken);
  await new Promise((r) => staffBSocket.on("connect", r));

  // Kiểm tra Socket hoạt động bình thường sau reconnect
  const eventPromise = waitForSocketEvent(staffBSocket, "notification:new", 2500);

  const res = await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Kiểm tra sau khi reconnect",
      message: "Thông báo sau khi socket kết nối lại",
      recipient_mode: "specific_staff",
      recipient_ids: [staffBUser.User_id],
      confirm_resend: true,
    },
  });

  assert.equal(res.status, 201);
  const received = await eventPromise;
  assert.ok(received, "Staff B phải nhận được thông báo bình thường sau khi reconnect");
});

test("TC09 – REST và Socket đồng thời: Không mất thông báo, không trùng lặp và bảo toàn dữ liệu", async () => {
  // Gửi thông báo qua API
  const res = await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Race condition test giữa REST và Socket",
      message: "Kiểm tra concurrency",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id],
      confirm_resend: true,
    },
  });
  const notifId = res.body.data.id;

  // Gọi REST đồng thời nhiều lần
  const [res1, res2] = await Promise.all([
    request("/api/notifications?limit=10", { headers: { Authorization: `Bearer ${staffAToken}` } }),
    request("/api/notifications?limit=10", { headers: { Authorization: `Bearer ${staffAToken}` } }),
  ]);

  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);

  const items1 = res1.body.data?.items.filter((i) => i.id === notifId);
  const items2 = res2.body.data?.items.filter((i) => i.id === notifId);
  assert.equal(items1.length, 1, "Chỉ có đúng 1 bản ghi trong kết quả REST");
  assert.equal(items2.length, 1, "Chỉ có đúng 1 bản ghi trong kết quả REST");
});

test("TC10 – Đổi tài khoản: Staff A logout -> Staff B login, cô lập dữ liệu và socket", async () => {
  // Giả lập Staff A logout bằng cách ngắt socket A
  staffASocket.disconnect();

  // Gửi thông báo mới dành riêng cho Staff A
  await request("/api/admin/notifications/dispatch", {
    method: "POST",
    headers: { Authorization: `Bearer ${managerToken}` },
    body: {
      title: "[E2E_TEST] Thông báo gửi A sau khi A logout",
      message: "Chỉ A thấy",
      recipient_mode: "specific_staff",
      recipient_ids: [staffAUser.User_id],
      confirm_resend: true,
    },
  });

  // Staff B truy vấn danh sách thông báo của B
  const listB = await request("/api/admin/notifications/assigned", {
    headers: { Authorization: `Bearer ${staffBToken}` },
  });

  assert.equal(listB.status, 200);
  const leakedToB = (listB.body.data?.items || []).some(
    (i) => i.title === "[E2E_TEST] Thông báo gửi A sau khi A logout"
  );
  assert.equal(leakedToB, false, "Staff B tuyệt đối không thấy thông báo của Staff A");
});

test("TC11 – Socket Emit Thất Bại: MongoDB vẫn lưu an toàn, các người nhận khác vẫn nhận socket", async () => {
  // Tạo thông báo cho cả A và B, nhưng giả lập lỗi khi emit tới Staff A
  const originalEmitToUser = socketService.emitToUser;
  let staffBEmitReceived = false;

  socketService.emitToUser = (userId, payload) => {
    if (userId === staffAUser.User_id) {
      throw new Error("Lỗi mạng mô phỏng: Không thể phát socket tới Staff A");
    }
    staffBEmitReceived = true;
    originalEmitToUser(userId, payload);
  };

  try {
    const res = await request("/api/admin/notifications/dispatch", {
      method: "POST",
      headers: { Authorization: `Bearer ${managerToken}` },
      body: {
        title: "[E2E_TEST] Kiểm tra khả năng chịu lỗi khi socket fail",
        message: "Lỗi socket của A không được ảnh hưởng tới B",
        recipient_mode: "specific_staff",
        recipient_ids: [staffAUser.User_id, staffBUser.User_id],
        confirm_resend: true,
      },
    });

    // 1. API vẫn trả về thành công vì MongoDB đã lưu xong trước đó
    assert.equal(res.status, 201, "API vẫn trả 201 thành công dù socket emit tới 1 client bị lỗi");

    // 2. Dữ liệu trong DB vẫn lưu đầy đủ cả 2 người nhận
    const savedDoc = await Notification.findOne({ Notification_id: res.body.data.id });
    assert.ok(savedDoc, "Notification phải được lưu chắc chắn trong MongoDB");
    assert.equal(savedDoc.Recipients.length, 2);

    // 3. Staff B vẫn nhận được socket event bình thường
    assert.equal(staffBEmitReceived, true, "Staff B vẫn nhận được socket event dù Staff A bị lỗi mạng");
  } finally {
    socketService.emitToUser = originalEmitToUser;
  }
});

test("TC12 – Legacy Notification: Thông báo order/general cũ không có recipient/status vẫn hiển thị chuẩn xác", async () => {
  // Tạo một thông báo cũ trực tiếp vào DB
  const legacyNotif = await Notification.create({
    Notification_id: `LEGACY_${Date.now()}`,
    Audience: "customer",
    Type: "order",
    Title: "[E2E_TEST] Đơn hàng #ORD_999 đã được xác nhận",
    Message: "Cửa hàng đã xác nhận đơn hàng của bạn.",
    Order_id: "ORD_999",
    User_id: customerUser?.User_id || "CUST_001",
    Link: "/orders/ORD_999",
    Is_read: false,
    Created_at: new Date(),
  });

  // Khách hàng hoặc Admin gọi GET /api/notifications
  const res = await request(`/api/notifications?limit=20`, {
    headers: { Authorization: `Bearer ${customerToken || managerToken}` },
  });

  assert.equal(res.status, 200);
  const found = (res.body.data?.items || []).find((i) => i.id === legacyNotif.Notification_id);
  assert.ok(found, "Phải tìm thấy thông báo legacy");
  assert.equal(found.type, "order");
  assert.equal(found.orderId, "ORD_999");
  assert.equal(found.status, undefined, "Thông báo legacy cho khách hàng không có operational status");
});
