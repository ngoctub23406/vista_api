const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const http = require("http");
const express = require("express");
const jwt = require("jsonwebtoken");

const Notification = require("../models/notification.model");
const { User, Order, Payment } = require("../models/schema");
const notificationService = require("../services/notification.service");
const notificationRoutes = require("../routes/notification.routes");
const socketService = require("../services/socket.service");

let server;
let serverPort;
let managerToken;
let staffToken;
let managerUser;
let staffUser;

async function sendRequest({ url, method = "GET", token, body = null }) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${serverPort}${url}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (e) {
            data = raw;
          }
          resolve({ status: res.statusCode, headers: res.headers, data });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.before(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  }

  managerUser = await User.findOne({ Role: "Manager", Status: "active" });
  staffUser = await User.findOne({ Role: "Staff", Status: "active" });
  assert.ok(managerUser, "Phải có Manager");
  assert.ok(staffUser, "Phải có Staff");

  managerToken = jwt.sign(
    { User_id: managerUser.User_id, Email: managerUser.Email, Role: "Manager" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  staffToken = jwt.sign(
    { User_id: staffUser.User_id, Email: staffUser.Email, Role: "Staff" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationRoutes);

  server = http.createServer(app);
  socketService.init(server);

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve();
    });
  });
});

test.after(async () => {
  try {
    await Notification.deleteMany({ Title: { $regex: /^\[ROLE_FILTER_TEST\]/ } });
  } catch (e) {}

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

test("Manager KHÔNG nhận thông báo đơn hàng mới giá trị thông thường (< 10 triệu)", async () => {
  const notifId = `NTF_NORMAL_${Date.now()}`;
  await Notification.create({
    Notification_id: notifId,
    Audience: "admin",
    Type: "order_created",
    Title: "[ROLE_FILTER_TEST] Đơn hàng mới thông thường",
    Message: "#ORD_NORM · Khách A · 1.500.000₫",
    Target_role: "Staff",
    Priority: "normal",
  });

  // Staff thấy
  const staffRes = await sendRequest({ url: "/api/notifications", token: staffToken });
  assert.equal(staffRes.status, 200);
  const staffItems = staffRes.data.data.items;
  assert.ok(staffItems.some((i) => i.id === notifId), "Staff phải thấy đơn hàng mới thông thường");

  // Manager KHÔNG thấy
  const managerRes = await sendRequest({ url: "/api/notifications", token: managerToken });
  assert.equal(managerRes.status, 200);
  const managerItems = managerRes.data.data.items;
  assert.equal(managerItems.some((i) => i.id === notifId), false, "Manager KHÔNG được thấy đơn mới thông thường");
});

test("Manager VÀ Staff ĐỀU nhận được thông báo đơn hàng giá trị cao (>= 10 triệu)", async () => {
  const notifId = `NTF_HIGH_VAL_${Date.now()}`;
  await Notification.create({
    Notification_id: notifId,
    Audience: "admin",
    Type: "order_created",
    Title: "[ROLE_FILTER_TEST] Đơn hàng giá trị cao",
    Message: "#ORD_HIGH · Khách B · 25.000.000₫ · Cần ưu tiên xử lý",
    Target_role: "all",
    Priority: "important",
  });

  // Staff thấy
  const staffRes = await sendRequest({ url: "/api/notifications", token: staffToken });
  assert.equal(staffRes.status, 200);
  assert.ok(staffRes.data.data.items.some((i) => i.id === notifId), "Staff phải thấy đơn giá trị cao");

  // Manager thấy
  const managerRes = await sendRequest({ url: "/api/notifications", token: managerToken });
  assert.equal(managerRes.status, 200);
  assert.ok(managerRes.data.data.items.some((i) => i.id === notifId), "Manager phải thấy đơn giá trị cao");
});

test("Manager VÀ Staff ĐỀU nhận được cảnh báo vi phạm SLA hoặc hoàn trả", async () => {
  const slaNotifId = `NTF_SLA_${Date.now()}`;
  await Notification.create({
    Notification_id: slaNotifId,
    Audience: "admin",
    Type: "sla_confirm_overdue",
    Title: "[ROLE_FILTER_TEST] Đơn quá hạn xác nhận",
    Message: "#ORD_SLA · Đã chờ hơn 2 giờ",
    Target_role: "all",
    Priority: "urgent",
  });

  const managerRes = await sendRequest({ url: "/api/notifications", token: managerToken });
  assert.equal(managerRes.status, 200);
  assert.ok(managerRes.data.data.items.some((i) => i.id === slaNotifId), "Manager phải nhận cảnh báo SLA");

  const staffRes = await sendRequest({ url: "/api/notifications", token: staffToken });
  assert.equal(staffRes.status, 200);
  assert.ok(staffRes.data.data.items.some((i) => i.id === slaNotifId), "Staff phải nhận cảnh báo SLA");
});
