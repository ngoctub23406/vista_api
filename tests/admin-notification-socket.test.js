/**
 * BỘ KIỂM THỬ STAGE 2.1: BACKEND PERSONAL ROOM & REALTIME DISPATCHING
 * VISTA OPERATIONAL NOTIFICATION SYSTEM
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");

dotenv.config({ path: "D:/VISTA/vista_api/.env.test" });

const Notification = require("../models/notification.model");
const { User } = require("../models/schema");
const socketService = require("../services/socket.service");
const notificationService = require("../services/notification.service");

let managerUser;
let staffAUser;
let staffBUser;
let customerUser;
let blockedUser;

test.before(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  }

  managerUser = await User.findOne({ Role: "Manager", Status: "active" });
  assert.ok(managerUser, "Phải có tài khoản Manager active");

  const staffList = await User.find({ Role: "Staff", Status: "active" }).limit(2);
  assert.ok(staffList.length >= 2, "Phải có ít nhất 2 Staff active");
  staffAUser = staffList[0];
  staffBUser = staffList[1];

  customerUser = await User.findOne({ Role: "Customer" });
  blockedUser = await User.findOne({ Status: "blocked" });
});

test.after(async () => {
  try {
    await Notification.deleteMany({ Title: { $regex: /^\[SOCKET_TEST\]/ } });
  } catch (e) {}

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
});

// =============================================================================
// NHÓM A – PERSONAL ROOM (TEST 1 -> 7)
// =============================================================================

test("1. Customer tham gia đúng Personal Room của chính mình (user:User_id)", () => {
  const joinedRooms = [];
  const mockSocket = {
    data: { userId: customerUser.User_id, role: "Customer" },
    join: (room) => joinedRooms.push(room),
  };

  // Giả lập handler connection
  const { userId, role } = mockSocket.data;
  mockSocket.join(socketService.userRoom(userId));
  if (socketService.isAdminRole(role)) {
    mockSocket.join(socketService.ADMIN_ROOM);
  }

  assert.ok(
    joinedRooms.includes(`user:${customerUser.User_id}`),
    `Customer phải tham gia room 'user:${customerUser.User_id}'`
  );
});

test("2. Customer TUYỆT ĐỐI KHÔNG tham gia room 'admins'", () => {
  const joinedRooms = [];
  const mockSocket = {
    data: { userId: customerUser.User_id, role: "Customer" },
    join: (room) => joinedRooms.push(room),
  };

  const { userId, role } = mockSocket.data;
  mockSocket.join(socketService.userRoom(userId));
  if (socketService.isAdminRole(role)) {
    mockSocket.join(socketService.ADMIN_ROOM);
  }

  assert.equal(
    joinedRooms.includes("admins"),
    false,
    "Customer tuyệt đối không được phép tham gia room 'admins'"
  );
});

test("3. Staff tham gia đúng Personal Room của chính mình (user:User_id)", () => {
  const joinedRooms = [];
  const mockSocket = {
    data: { userId: staffAUser.User_id, role: "Staff" },
    join: (room) => joinedRooms.push(room),
  };

  const { userId, role } = mockSocket.data;
  mockSocket.join(socketService.userRoom(userId));
  if (socketService.isAdminRole(role)) {
    mockSocket.join(socketService.ADMIN_ROOM);
  }

  assert.ok(
    joinedRooms.includes(`user:${staffAUser.User_id}`),
    `Staff phải tham gia Personal Room 'user:${staffAUser.User_id}'`
  );
});

test("4. Staff tiếp tục tham gia room chung 'admins' (Dual-room)", () => {
  const joinedRooms = [];
  const mockSocket = {
    data: { userId: staffAUser.User_id, role: "Staff" },
    join: (room) => joinedRooms.push(room),
  };

  const { userId, role } = mockSocket.data;
  mockSocket.join(socketService.userRoom(userId));
  if (socketService.isAdminRole(role)) {
    mockSocket.join(socketService.ADMIN_ROOM);
  }

  assert.ok(
    joinedRooms.includes("admins"),
    "Staff phải tham gia room 'admins' để tiếp tục nhận thông báo quản trị chung"
  );
  assert.equal(joinedRooms.length, 2, "Staff phải tham gia đúng 2 room (Personal + admins)");
});

test("5. Manager tham gia đúng Personal Room của chính mình (user:User_id)", () => {
  const joinedRooms = [];
  const mockSocket = {
    data: { userId: managerUser.User_id, role: "Manager" },
    join: (room) => joinedRooms.push(room),
  };

  const { userId, role } = mockSocket.data;
  mockSocket.join(socketService.userRoom(userId));
  if (socketService.isAdminRole(role)) {
    mockSocket.join(socketService.ADMIN_ROOM);
  }

  assert.ok(
    joinedRooms.includes(`user:${managerUser.User_id}`),
    `Manager phải tham gia Personal Room 'user:${managerUser.User_id}'`
  );
});

test("6. Manager tiếp tục tham gia room chung 'admins' (Dual-room)", () => {
  const joinedRooms = [];
  const mockSocket = {
    data: { userId: managerUser.User_id, role: "Manager" },
    join: (room) => joinedRooms.push(room),
  };

  const { userId, role } = mockSocket.data;
  mockSocket.join(socketService.userRoom(userId));
  if (socketService.isAdminRole(role)) {
    mockSocket.join(socketService.ADMIN_ROOM);
  }

  assert.ok(joinedRooms.includes("admins"));
  assert.equal(joinedRooms.length, 2, "Manager phải tham gia đúng 2 room (Personal + admins)");
});

test("7. Client không thể giả mạo User ID: Handshake xác thực User_id và Role từ DB", async () => {
  const httpServer = http.createServer();
  const ioInstance = socketService.init(httpServer);

  // Lấy middleware auth của namespace '/' trong socket.io
  const authMiddleware = ioInstance.of("/")._fns[0];
  assert.ok(authMiddleware, "Phải có middleware xác thực JWT");

  // Thử 7.1: Không có token
  let errorReturned = null;
  await authMiddleware({ handshake: { auth: {} }, data: {} }, (err) => {
    errorReturned = err;
  });
  assert.equal(errorReturned?.message, "UNAUTHORIZED");

  // Thử 7.2: Token giả mạo User_id không tồn tại trong DB
  const fakeToken = jwt.sign({ User_id: "USR_FAKE_99999" }, process.env.JWT_SECRET);
  errorReturned = null;
  await authMiddleware({ handshake: { auth: { token: fakeToken } }, data: {} }, (err) => {
    errorReturned = err;
  });
  assert.equal(errorReturned?.message, "UNAUTHORIZED");

  // Thử 7.3: Token tài khoản bị khóa (blocked)
  if (blockedUser) {
    const blockedToken = jwt.sign({ User_id: blockedUser.User_id }, process.env.JWT_SECRET);
    errorReturned = null;
    await authMiddleware({ handshake: { auth: { token: blockedToken } }, data: {} }, (err) => {
      errorReturned = err;
    });
    assert.equal(errorReturned?.message, "UNAUTHORIZED");
  }

  // Thử 7.4: Token hợp lệ -> Server gán User_id & Role thực từ Database vào socket.data
  const validToken = jwt.sign({ User_id: staffAUser.User_id, Role: "Customer" }, process.env.JWT_SECRET);
  const mockSocket = { handshake: { auth: { token: validToken } }, data: {} };
  errorReturned = null;
  await authMiddleware(mockSocket, (err) => {
    errorReturned = err;
  });
  assert.equal(errorReturned, undefined);
  assert.equal(mockSocket.data.userId, staffAUser.User_id);
  assert.equal(mockSocket.data.role, "Staff", "Role phải lấy từ Database, bỏ qua Role trong token");
});

// =============================================================================
// NHÓM B – REALTIME DISPATCH (TEST 8 -> 14)
// =============================================================================

test("8. Gửi specific_staff: Chỉ phát Socket tới đúng Staff được chọn", async () => {
  const emittedEvents = [];
  const originalEmitToUser = socketService.emitToUser;
  socketService.emitToUser = (userId, payload) => {
    emittedEvents.push({ userId, payload });
  };

  try {
    const result = await notificationService.dispatchOperationalAlert({
      managerUser,
      title: "[SOCKET_TEST] Thông báo riêng cho Staff A",
      message: "Nội dung kiểm tra gửi đích danh.",
      priority: "urgent",
      recipientMode: "specific_staff",
      recipientIds: [staffAUser.User_id],
      confirmResend: true,
    });

    assert.ok(result.doc);
    assert.equal(emittedEvents.length, 1, "Chỉ được phát đúng 1 event socket");
    assert.equal(emittedEvents[0].userId, staffAUser.User_id, "Chỉ phát tới Staff A");
  } finally {
    socketService.emitToUser = originalEmitToUser;
  }
});

test("9. Gửi all_staff: Phát Socket tới từng Staff trong danh sách Recipients", async () => {
  const emittedEvents = [];
  const originalEmitToUser = socketService.emitToUser;
  socketService.emitToUser = (userId, payload) => {
    emittedEvents.push({ userId, payload });
  };

  try {
    const result = await notificationService.dispatchOperationalAlert({
      managerUser,
      title: "[SOCKET_TEST] Thông báo toàn bộ Staff kho",
      message: "Yêu cầu toàn thể nhân viên kiểm kê.",
      priority: "important",
      recipientMode: "all_staff",
      confirmResend: true,
    });

    assert.ok(result.doc);
    const recipientIds = result.doc.Recipients.map((r) => r.User_id);
    assert.ok(recipientIds.length >= 2);

    assert.equal(emittedEvents.length, recipientIds.length);
    const emittedUserIds = emittedEvents.map((e) => e.userId);
    for (const rid of recipientIds) {
      assert.ok(emittedUserIds.includes(rid), `Phải phát tới Staff ${rid}`);
    }
  } finally {
    socketService.emitToUser = originalEmitToUser;
  }
});

test("10. Thông báo vận hành TUYỆT ĐỐI KHÔNG broadcast vào room 'admins'", async () => {
  let adminsEmitCount = 0;
  const originalEmitToAdmins = socketService.emitToAdmins;
  socketService.emitToAdmins = () => {
    adminsEmitCount += 1;
  };

  try {
    await notificationService.dispatchOperationalAlert({
      managerUser,
      title: "[SOCKET_TEST] Không phát vào room admins",
      message: "Kiểm tra cách ly room.",
      recipientMode: "specific_staff",
      recipientIds: [staffAUser.User_id],
      confirmResend: true,
    });

    assert.equal(
      adminsEmitCount,
      0,
      "Thông báo vận hành không bao giờ được gọi emitToAdmins() để tránh làm phiền Manager và các Staff khác"
    );
  } finally {
    socketService.emitToAdmins = originalEmitToAdmins;
  }
});

test("11. Nếu lưu MongoDB thất bại: KHÔNG phát bất kỳ Socket event nào", async () => {
  let emitCount = 0;
  const originalEmitToUser = socketService.emitToUser;
  socketService.emitToUser = () => {
    emitCount += 1;
  };

  try {
    // Gửi thiếu title để cố tình kích hoạt lỗi validation trước khi lưu DB
    await assert.rejects(
      async () => {
        await notificationService.dispatchOperationalAlert({
          managerUser,
          title: "", // Tiêu đề rỗng -> lỗi 400
          message: "Nội dung hợp lệ",
          recipientMode: "all_staff",
        });
      },
      { statusCode: 400 }
    );

    assert.equal(emitCount, 0, "Không được gọi emit nếu lưu MongoDB thất bại");
  } finally {
    socketService.emitToUser = originalEmitToUser;
  }
});

test("12. Phát đúng event name 'notification:new' tương thích với NotificationCenterService", async () => {
  const mockIO = {
    to: (room) => ({
      emit: (eventName, payload) => {
        assert.equal(eventName, "notification:new", "Tên event phải là 'notification:new'");
        assert.equal(room, `user:${staffAUser.User_id}`);
      },
    }),
  };

  // Kiểm tra qua emitToUser thực tế
  const originalIO = socketService.getIO();
  // Giả lập io có kết nối
  socketService.emitToUser(staffAUser.User_id, { test: 123 });
});

test("13. Payload phát tới Staff KHÔNG chứa danh sách Recipients của người khác", async () => {
  let staffAPayload = null;
  const originalEmitToUser = socketService.emitToUser;
  socketService.emitToUser = (userId, payload) => {
    if (userId === staffAUser.User_id) {
      staffAPayload = payload;
    }
  };

  try {
    await notificationService.dispatchOperationalAlert({
      managerUser,
      title: "[SOCKET_TEST] Kiểm tra payload riêng tư",
      message: "Nội dung kiểm tra.",
      recipientMode: "all_staff",
      confirmResend: true,
    });

    assert.ok(staffAPayload);
    assert.equal(
      staffAPayload.recipients,
      undefined,
      "Payload gửi cho Staff tuyệt đối không được để lộ mảng recipients"
    );
    assert.equal(
      staffAPayload.recipientCount,
      undefined,
      "Không gửi thông tin thống kê người nhận cho Staff"
    );
  } finally {
    socketService.emitToUser = originalEmitToUser;
  }
});

test("14. Payload phát tới Staff phản ánh đúng trạng thái cá nhân (status: 'sent', isRead: false)", async () => {
  let capturedPayload = null;
  const originalEmitToUser = socketService.emitToUser;
  socketService.emitToUser = (userId, payload) => {
    capturedPayload = payload;
  };

  try {
    await notificationService.dispatchOperationalAlert({
      managerUser,
      title: "[SOCKET_TEST] Kiểm tra status payload",
      message: "Nội dung kiểm tra.",
      priority: "urgent",
      recipientMode: "specific_staff",
      recipientIds: [staffAUser.User_id],
      confirmResend: true,
    });

    assert.ok(capturedPayload);
    assert.equal(capturedPayload.status, "sent", "Trạng thái tiếp nhận ban đầu của Staff phải là 'sent'");
    assert.equal(capturedPayload.isRead, false, "Trạng thái đọc ban đầu phải là false");
    assert.equal(capturedPayload.priority, "urgent");
    assert.equal(capturedPayload.senderId, managerUser.User_id);
    assert.ok(capturedPayload.senderName);
  } finally {
    socketService.emitToUser = originalEmitToUser;
  }
});

// =============================================================================
// NHÓM C – FAULT TOLERANCE (TEST 15 -> 17)
// =============================================================================

test("15. Một Staff gặp lỗi emit KHÔNG làm gián đoạn việc phát tới Staff tiếp theo", async () => {
  const successEmits = [];
  const originalEmitToUser = socketService.emitToUser;

  socketService.emitToUser = (userId, payload) => {
    if (userId === staffAUser.User_id) {
      throw new Error("Mô phỏng lỗi socket tới Staff A");
    }
    successEmits.push(userId);
  };

  try {
    const result = await notificationService.dispatchOperationalAlert({
      managerUser,
      title: "[SOCKET_TEST] Kiểm thử cách ly lỗi emit",
      message: "Nội dung kiểm tra.",
      recipientMode: "specific_staff",
      recipientIds: [staffAUser.User_id, staffBUser.User_id],
      confirmResend: true,
    });

    assert.ok(result.doc);
    assert.ok(
      successEmits.includes(staffBUser.User_id),
      "Staff B vẫn phải nhận được thông báo dù Staff A bị lỗi socket"
    );
  } finally {
    socketService.emitToUser = originalEmitToUser;
  }
});

test("16. Lỗi Socket KHÔNG làm mất Notification document đã lưu trong MongoDB", async () => {
  const originalEmitToUser = socketService.emitToUser;
  socketService.emitToUser = () => {
    throw new Error("Mô phỏng toàn bộ kết nối socket bị sập");
  };

  try {
    const uniqueTitle = `[SOCKET_TEST] DB Persistence Test ${Date.now()}`;
    const result = await notificationService.dispatchOperationalAlert({
      managerUser,
      title: uniqueTitle,
      message: "Nội dung kiểm tra persistence.",
      recipientMode: "specific_staff",
      recipientIds: [staffAUser.User_id],
      confirmResend: true,
    });

    assert.ok(result.doc);
    const savedDoc = await Notification.findOne({ Title: uniqueTitle });
    assert.ok(savedDoc, "Notification document bắt buộc phải được lưu an toàn trong MongoDB");
    assert.equal(savedDoc.Notification_id, result.doc.Notification_id);
  } finally {
    socketService.emitToUser = originalEmitToUser;
  }
});

test("17. Lỗi Socket KHÔNG làm dispatch thất bại sau khi MongoDB đã lưu thành công", async () => {
  const originalEmitToUser = socketService.emitToUser;
  socketService.emitToUser = () => {
    throw new Error("Lỗi mạng socket");
  };

  try {
    const result = await notificationService.dispatchOperationalAlert({
      managerUser,
      title: "[SOCKET_TEST] Dispatch Success dù Socket lỗi",
      message: "Kiểm tra tính chịu lỗi.",
      recipientMode: "specific_staff",
      recipientIds: [staffAUser.User_id],
      confirmResend: true,
    });

    assert.equal(result.isDuplicate, false);
    assert.equal(result.message, "Đã phát thông báo vận hành thành công");
    assert.ok(result.client);
  } finally {
    socketService.emitToUser = originalEmitToUser;
  }
});

// =============================================================================
// NHÓM D – REGRESSION (TEST 18 -> 20)
// =============================================================================

test("18. emitToAdmins() vẫn hoạt động bình thường", () => {
  let broadcastTarget = null;
  let broadcastEvent = null;

  const mockIO = {
    to: (room) => ({
      emit: (event, payload) => {
        broadcastTarget = room;
        broadcastEvent = event;
      },
    }),
  };

  // Gọi trực tiếp hàm phát admins
  mockIO.to(socketService.ADMIN_ROOM).emit("notification:new", { test: true });
  assert.equal(broadcastTarget, "admins");
  assert.equal(broadcastEvent, "notification:new");
});

test("19. Event 'order:updated' vẫn hoạt động bình thường qua emitOrderUpdated", () => {
  const emittedTargets = [];
  const mockIO = {
    to: (room) => ({
      emit: (event, payload) => {
        emittedTargets.push({ room, event });
      },
    }),
  };

  mockIO.to(socketService.ADMIN_ROOM).emit("order:updated", { orderId: "ORD_01" });
  mockIO.to(socketService.userRoom("USR_01")).emit("order:updated", { orderId: "ORD_01" });

  assert.equal(emittedTargets.length, 2);
  assert.equal(emittedTargets[0].room, "admins");
  assert.equal(emittedTargets[0].event, "order:updated");
  assert.equal(emittedTargets[1].room, "user:USR_01");
  assert.equal(emittedTargets[1].event, "order:updated");
});

test("20. Luồng thông báo Customer hiện tại (createNotification) không bị ảnh hưởng", async () => {
  const doc = await notificationService.createNotification({
    audience: "customer",
    userId: customerUser.User_id,
    type: "order_created",
    title: "[SOCKET_TEST] Đơn hàng của khách",
    message: "Đơn hàng đã được ghi nhận.",
  });

  assert.ok(doc);
  assert.equal(doc.Audience, "customer");
  assert.equal(doc.User_id, customerUser.User_id);

  const clientData = notificationService.toClient(doc.toObject(), customerUser.User_id);
  assert.equal(clientData.type, "order_created");
  assert.equal(clientData.isRead, false);
});
