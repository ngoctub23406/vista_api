const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Load cấu hình test an toàn từ .env.test
dotenv.config({ path: path.resolve(__dirname, "../.env.test") });

const { User, Address, Order, Return_order } = require("../models/schema");
const authMiddleware = require("../middleware/auth.middleware");
const customerController = require("../controllers/admin/customer.controller");

// Định danh test fixtures
const MGR_ID = "TEST_ADM_MGR_001";
const STF_ID = "TEST_ADM_STF_001";
const CUST_1_ID = "TEST_ADM_CUST_001";
const CUST_2_ID = "TEST_ADM_CUST_002";
const CUST_NO_DATA_ID = "TEST_ADM_CUST_003";

// User test riêng biệt cho Giai đoạn 2D (kiểm thử đổi trả một phần và các trường hợp biên)
const CUST_2D_ID = "TEST_ADM_CUST_2D";
const CUST_2D_OTHER_ID = "TEST_ADM_CUST_2D_OTHER";

let managerToken = "";
let staffToken = "";
let customerToken = "";

function createMockRes(onFinish) {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      if (onFinish) onFinish(this);
      return this;
    },
  };
}

async function callAdminCustomerList(token, query = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (resObj) => {
      if (!resolved) {
        resolved = true;
        resolve(resObj);
      }
    };

    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      query,
    };
    const res = createMockRes(finish);

    authMiddleware(req, res, (err) => {
      if (err) return;
      const roleCheck = authMiddleware.requireRole("Manager", "Staff");
      roleCheck(req, res, async () => {
        try {
          await customerController.getCustomers(req, res);
        } catch (handlerErr) {
          res.status(500).json({ success: false, message: handlerErr.message });
        }
      });
    });
  });
}

async function callAdminCustomerDetail(token, id) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (resObj) => {
      if (!resolved) {
        resolved = true;
        resolve(resObj);
      }
    };

    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      params: { id },
    };
    const res = createMockRes(finish);

    authMiddleware(req, res, (err) => {
      if (err) return;
      const roleCheck = authMiddleware.requireRole("Manager", "Staff");
      roleCheck(req, res, async () => {
        try {
          await customerController.getCustomerById(req, res);
        } catch (handlerErr) {
          res.status(500).json({ success: false, message: handlerErr.message });
        }
      });
    });
  });
}

const authController = require("../controllers/auth.controller");

async function callAdminCustomerLock(token, id, body = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (resObj) => {
      if (!resolved) {
        resolved = true;
        resolve(resObj);
      }
    };

    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      params: { id },
      body,
    };
    const res = createMockRes(finish);

    authMiddleware(req, res, (err) => {
      if (err) return;
      const roleCheck = authMiddleware.requireRole("Manager");
      roleCheck(req, res, async () => {
        try {
          await customerController.lockCustomer(req, res);
        } catch (handlerErr) {
          res.status(500).json({ success: false, message: handlerErr.message });
        }
      });
    });
  });
}

async function callAdminCustomerUnlock(token, id, body = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (resObj) => {
      if (!resolved) {
        resolved = true;
        resolve(resObj);
      }
    };

    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      params: { id },
      body,
    };
    const res = createMockRes(finish);

    authMiddleware(req, res, (err) => {
      if (err) return;
      const roleCheck = authMiddleware.requireRole("Manager");
      roleCheck(req, res, async () => {
        try {
          await customerController.unlockCustomer(req, res);
        } catch (handlerErr) {
          res.status(500).json({ success: false, message: handlerErr.message });
        }
      });
    });
  });
}

async function callCustomerMe(token) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (resObj) => {
      if (!resolved) {
        resolved = true;
        resolve(resObj);
      }
    };

    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    };
    const res = createMockRes(finish);

    authMiddleware(req, res, async (err) => {
      if (err) return;
      try {
        await authController.getMe(req, res);
      } catch (handlerErr) {
        res.status(500).json({ success: false, message: handlerErr.message });
      }
    });
  });
}


test.before(async () => {
  // 1. Kiểm tra an toàn database
  const mongoUri = process.env.MONGODB_URI || "";
  if (!mongoUri.includes("vista_test")) {
    throw new Error(`ABORT: Database URI must target 'vista_test'. Refusing on: ${mongoUri}`);
  }

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri);
  }

  const dbName = mongoose.connection.name;
  if (dbName !== "vista_test") {
    throw new Error(`ABORT: Connected db name is '${dbName}', expected 'vista_test'!`);
  }

  // 2. Dọn dẹp fixtures cũ nếu còn
  await cleanupFixtures();

  const hashedPass = await bcrypt.hash("Password123!", 10);

  // 3. Tạo tài khoản Manager & Staff & Customers
  await User.create([
    {
      User_id: MGR_ID,
      Username: "test_mgr_001",
      Email: "test_mgr_001@vista.test.local",
      Password: hashedPass,
      Full_name: "Quản Lý VISTA",
      Role: "Manager",
      Status: "active",
    },
    {
      User_id: STF_ID,
      Username: "test_stf_001",
      Email: "test_stf_001@vista.test.local",
      Password: hashedPass,
      Full_name: "Nhân Viên VISTA",
      Role: "Staff",
      Status: "active",
    },
    {
      User_id: CUST_1_ID,
      Username: "test_cust_an",
      Email: "an.nguyen@vista.test.local",
      Password: hashedPass,
      Full_name: "Nguyễn Văn An",
      Phone_number: "0901234567",
      Role: "Customer",
      Status: "active",
      Total_spent: 99999999, // Dữ liệu cũ không đáng tin cậy
    },
    {
      User_id: CUST_2_ID,
      Username: "test_cust_binh",
      Email: "binh.tran@vista.test.local",
      Password: hashedPass,
      Full_name: "Trần Thị Bình",
      Phone_number: "0987654321",
      Role: "Customer",
      Status: "blocked",
      Total_spent: 0,
    },
    {
      User_id: CUST_NO_DATA_ID,
      Username: "test_cust_trong",
      Email: "trong.le@vista.test.local",
      Password: hashedPass,
      Full_name: "Lê Văn Trống",
      Phone_number: "0912345678",
      Role: "Customer",
      Status: "active",
      Total_spent: 0,
    },
    {
      User_id: CUST_2D_ID,
      Username: "test_cust_2d",
      Email: "cust2d@vista.test.local",
      Password: hashedPass,
      Full_name: "Khách Hàng Test 2D",
      Phone_number: "0966778899",
      Role: "Customer",
      Status: "active",
      Total_spent: 0,
    },
    {
      User_id: CUST_2D_OTHER_ID,
      Username: "test_cust_2d_other",
      Email: "cust2d_other@vista.test.local",
      Password: hashedPass,
      Full_name: "Khách Hàng Khác 2D",
      Phone_number: "0911223344",
      Role: "Customer",
      Status: "active",
      Total_spent: 0,
    },
  ]);

  // 4. Tạo Address cho CUST_1
  await Address.create([
    {
      Address_id: "TEST_ADDR_001",
      User_id: CUST_1_ID,
      Receiver_name: "Nguyễn Văn An",
      Receiver_phone: "0901234567",
      Email: "an.nguyen@vista.test.local",
      Province: "Hồ Chí Minh",
      District: "Quận 1",
      Ward: "Phường Bến Nghé",
      Specific_address: "123 Lê Lợi",
      Is_default: true,
    },
    {
      Address_id: "TEST_ADDR_002",
      User_id: CUST_1_ID,
      Receiver_name: "An Công Ty",
      Receiver_phone: "0901234567",
      Email: "an.nguyen@vista.test.local",
      Province: "Hồ Chí Minh",
      District: "Quận 3",
      Ward: "Phường 6",
      Specific_address: "456 Võ Văn Tần",
      Is_default: false,
    },
  ]);

  // 5. Tạo Orders cho CUST_1
  await Order.create([
    {
      Order_id: "TEST_ORD_001",
      User_id: CUST_1_ID,
      Total_items_price: 500000,
      Total_amount: 500000,
      Status: "delivered",
    },
    {
      Order_id: "TEST_ORD_002",
      User_id: CUST_1_ID,
      Total_items_price: 1000000,
      Total_amount: 1000000,
      Status: "review",
    },
    {
      Order_id: "TEST_ORD_003",
      User_id: CUST_1_ID,
      Total_items_price: 300000,
      Total_amount: 300000,
      Status: "processing",
    },
    {
      Order_id: "TEST_ORD_004",
      User_id: CUST_1_ID,
      Total_items_price: 400000,
      Total_amount: 400000,
      Status: "shipping",
    },
    {
      Order_id: "TEST_ORD_005",
      User_id: CUST_1_ID,
      Total_items_price: 250000,
      Total_amount: 250000,
      Status: "cancelled",
    },
  ]);

  // 6. Tạo Return_order cho CUST_1
  await Return_order.create([
    {
      Return_order_id: "TEST_RET_001",
      Product_variant_id: "VAR_TEST",
      Order_id: "TEST_ORD_002",
      Product_variant_id: "VAR_001",
      Reason_type: "defective",
      Refund_amount: 200000,
      Status: "completed",
    },
    {
      Return_order_id: "TEST_RET_002",
      Product_variant_id: "VAR_TEST",
      Order_id: "TEST_ORD_002",
      Product_variant_id: "VAR_002",
      Reason_type: "wrong_item",
      Refund_amount: 100000,
      Status: "pending",
    },
    {
      Return_order_id: "TEST_RET_003",
      Product_variant_id: "VAR_TEST",
      Order_id: "TEST_ORD_001",
      Product_variant_id: "VAR_003",
      Reason_type: "changed_mind",
      Refund_amount: 50000,
      Status: "rejected",
    },
  ]);

  // 7. Tạo JWT Tokens
  managerToken = jwt.sign(
    { User_id: MGR_ID, Email: "test_mgr_001@vista.test.local", Role: "Manager" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  staffToken = jwt.sign(
    { User_id: STF_ID, Email: "test_stf_001@vista.test.local", Role: "Staff" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  customerToken = jwt.sign(
    { User_id: CUST_1_ID, Email: "an.nguyen@vista.test.local", Role: "Customer" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
});

async function cleanupFixtures() {
  await User.deleteMany({
    User_id: { $in: [MGR_ID, STF_ID, CUST_1_ID, CUST_2_ID, CUST_NO_DATA_ID, CUST_2D_ID, CUST_2D_OTHER_ID, "TEST_ADM_CUST_G3"] },
  });
  await Address.deleteMany({
    User_id: { $in: [MGR_ID, STF_ID, CUST_1_ID, CUST_2_ID, CUST_NO_DATA_ID, CUST_2D_ID, CUST_2D_OTHER_ID, "TEST_ADM_CUST_G3"] },
  });
  await Order.deleteMany({
    Order_id: /^TEST_ORD_/,
  });
  await Return_order.deleteMany({
    Return_order_id: /^TEST_RET_/,
  });
}

test.after(async () => {
  await cleanupFixtures();
  await mongoose.disconnect();
});

// ==========================================
// A. TEST API DANH SÁCH (GET /api/admin/customers)
// ==========================================

test("LIST-01: Manager truy cập thành công danh sách khách hàng", async () => {
  const res = await callAdminCustomerList(managerToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.total >= 3);
});

test("LIST-02: Staff truy cập thành công danh sách khách hàng", async () => {
  const res = await callAdminCustomerList(staffToken);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.items));
});

test("LIST-03: Customer bị chặn truy cập (403 Forbidden)", async () => {
  const res = await callAdminCustomerList(customerToken);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
});

test("LIST-04: Không có token bị chặn truy cập (401 Unauthorized)", async () => {
  const res = await callAdminCustomerList(null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
});

test("LIST-05: Tuyệt đối không trả về tài khoản Manager hoặc Staff trong danh sách", async () => {
  const res = await callAdminCustomerList(managerToken, { limit: 50 });
  assert.equal(res.statusCode, 200);

  const returnedIds = res.body.items.map((u) => u.User_id);
  assert.equal(returnedIds.includes(MGR_ID), false, "Manager must NOT be returned");
  assert.equal(returnedIds.includes(STF_ID), false, "Staff must NOT be returned");

  for (const item of res.body.items) {
    assert.equal(item.Role !== "Manager" && item.Role !== "Staff", true);
  }
});

test("LIST-06: Tìm kiếm theo User_id", async () => {
  const res = await callAdminCustomerList(managerToken, { keyword: CUST_1_ID });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].User_id, CUST_1_ID);
});

test("LIST-07: Tìm kiếm theo Username", async () => {
  const res = await callAdminCustomerList(managerToken, { keyword: "test_cust_an" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].Username, "test_cust_an");
});

test("LIST-08: Tìm kiếm theo Full_name", async () => {
  const res = await callAdminCustomerList(managerToken, { keyword: "Nguyễn Văn An" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.items.length >= 1, "Phải có ít nhất 1 kết quả cho Nguyễn Văn An");
  assert.ok(
    res.body.items.some((item) => item.Full_name === "Nguyễn Văn An"),
    "Phải tìm thấy khách hàng Nguyễn Văn An trong kết quả"
  );
});

test("LIST-09: Tìm kiếm theo Email", async () => {
  const res = await callAdminCustomerList(managerToken, { keyword: "binh.tran@vista.test.local" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].Email, "binh.tran@vista.test.local");
});

test("LIST-10: Tìm kiếm theo Phone_number", async () => {
  const res = await callAdminCustomerList(managerToken, { keyword: "0901234567" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 1);
  assert.equal(res.body.items[0].Phone_number, "0901234567");
});

test("LIST-11: Lọc status = active", async () => {
  const res = await callAdminCustomerList(managerToken, { status: "active" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.items.length > 0);
  for (const item of res.body.items) {
    assert.equal(item.Status, "active");
  }
});

test("LIST-12: Lọc status = blocked", async () => {
  const res = await callAdminCustomerList(managerToken, { status: "blocked" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.items.length > 0);
  for (const item of res.body.items) {
    assert.equal(item.Status, "blocked");
  }
});

test("LIST-13: Kết hợp keyword và status", async () => {
  let res = await callAdminCustomerList(managerToken, { keyword: "An", status: "blocked" });
  assert.equal(res.statusCode, 200);
  const foundAn = res.body.items.find((i) => i.User_id === CUST_1_ID);
  assert.equal(foundAn, undefined, "Khách hàng An active không được xuất hiện khi lọc status=blocked");

  res = await callAdminCustomerList(managerToken, { keyword: "An", status: "active" });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.items.length >= 1, "Phải có kết quả khi tìm kiếm An với status=active");
  const foundActiveAn = res.body.items.find((i) => i.User_id === CUST_1_ID);
  assert.ok(foundActiveAn, "Phải tìm thấy khách hàng An trong danh sách active");
  assert.equal(foundActiveAn.Status, "active");
});

test("LIST-14: Phân trang đúng (page, limit, totalPages)", async () => {
  const res = await callAdminCustomerList(managerToken, { page: 1, limit: 2 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 2);
  assert.equal(res.body.page, 1);
  assert.equal(res.body.limit, 2);
  assert.ok(res.body.totalPages >= 2);
});

test("LIST-15: page/limit không hợp lệ -> Fallback an toàn", async () => {
  const res = await callAdminCustomerList(managerToken, { page: -5, limit: 999 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.page, 1);
  assert.equal(res.body.limit, 50);
});

test("LIST-16: Tìm kiếm không có kết quả -> items rỗng, total = 0", async () => {
  const res = await callAdminCustomerList(managerToken, { keyword: "NON_EXISTENT_KEYWORD_XYZ_999" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.items.length, 0);
  assert.equal(res.body.total, 0);
  assert.equal(res.body.totalPages, 0);
});

test("LIST-17: Dữ liệu nhạy cảm không xuất hiện trong response danh sách", async () => {
  const res = await callAdminCustomerList(managerToken);
  assert.equal(res.statusCode, 200);
  for (const item of res.body.items) {
    assert.equal(item.Password, undefined);
    assert.equal(item.Reset_otp, undefined);
    assert.equal(item.Reset_otp_expires, undefined);
    assert.equal(item.Admin_reset_otp_hash, undefined);
    assert.equal(item.Admin_reset_otp_expires, undefined);
  }
});

// ==========================================
// B. TEST API CHI TIẾT (GET /api/admin/customers/:id)
// ==========================================

test("DETAIL-01: Manager xem chi tiết khách hàng hợp lệ thành công", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.customer.User_id, CUST_1_ID);
  assert.ok(Array.isArray(res.body.addresses));
  assert.ok(res.body.orderStats);
});

test("DETAIL-02: Staff xem chi tiết khách hàng hợp lệ thành công", async () => {
  const res = await callAdminCustomerDetail(staffToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.customer.User_id, CUST_1_ID);
});

test("DETAIL-03: Customer bị chặn xem chi tiết (403 Forbidden)", async () => {
  const res = await callAdminCustomerDetail(customerToken, CUST_1_ID);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
});

test("DETAIL-04: Không có token bị chặn xem chi tiết (401 Unauthorized)", async () => {
  const res = await callAdminCustomerDetail(null, CUST_1_ID);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
});

test("DETAIL-05: User_id không tồn tại -> Trả về 404 Not Found", async () => {
  const res = await callAdminCustomerDetail(managerToken, "NON_EXISTENT_USER_ID");
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Không tìm thấy khách hàng/);
});

test("DETAIL-06: User_id thuộc Manager -> Trả về 404 Not Found (không lộ Manager)", async () => {
  const res = await callAdminCustomerDetail(managerToken, MGR_ID);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Không tìm thấy khách hàng/);
});

test("DETAIL-07: User_id thuộc Staff -> Trả về 404 Not Found (không lộ Staff)", async () => {
  const res = await callAdminCustomerDetail(managerToken, STF_ID);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Không tìm thấy khách hàng/);
});

test("DETAIL-08: Trả đúng thông tin hồ sơ của khách hàng", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  const cust = res.body.customer;
  assert.equal(cust.User_id, CUST_1_ID);
  assert.equal(cust.Username, "test_cust_an");
  assert.equal(cust.Full_name, "Nguyễn Văn An");
  assert.equal(cust.Email, "an.nguyen@vista.test.local");
  assert.equal(cust.Phone_number, "0901234567");
  assert.equal(cust.Status, "active");
});

test("DETAIL-09: Trả đúng danh sách Address thực tế trong database", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.addresses.length, 2);

  const defaultAddr = res.body.addresses[0];
  assert.equal(defaultAddr.Address_id, "TEST_ADDR_001");
  assert.equal(defaultAddr.Is_default, true);
  assert.equal(defaultAddr.Receiver_name, "Nguyễn Văn An");
  assert.equal(defaultAddr.Specific_address, "123 Lê Lợi");
  assert.equal(defaultAddr.Province, "Hồ Chí Minh");
});

test("DETAIL-10: Khách hàng chưa có Address -> Trả mảng addresses rỗng", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_NO_DATA_ID);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.addresses, []);
});

test("DETAIL-11: Đếm đúng số đơn hàng theo từng nhóm trạng thái", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  const stats = res.body.orderStats;

  assert.equal(stats.total, 5, "Total orders must be 5");
  assert.equal(stats.completed, 2, "Completed orders must be 2");
  assert.equal(stats.processing, 2, "Processing orders must be 2");
  assert.equal(stats.cancelled, 1, "Cancelled orders must be 1");
});

test("DETAIL-12: Không đếm trùng đơn hàng", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  const stats = res.body.orderStats;
  assert.equal(
    stats.completed + stats.processing + stats.cancelled,
    stats.total,
    "Sum of categories must equal total"
  );
});

test("DETAIL-13: Tính tổng chi tiêu đúng với dữ liệu hoàn tiền hợp lệ", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  const stats = res.body.orderStats;

  // ORD_001 (delivered: 500k) + ORD_002 (review: 1M - 200k hoàn = 800k) = 1.300.000 đ
  assert.equal(
    stats.totalSpent,
    1300000,
    `totalSpent must be 1,300,000 đ, got ${stats.totalSpent}`
  );
});

test("DETAIL-14: Không trừ khoản hoàn tiền chưa được duyệt (pending/rejected)", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  const stats = res.body.orderStats;

  assert.equal(stats.totalSpent, 1300000);
});

test("DETAIL-15: Đổi trả nhiều sản phẩm trên cùng một đơn không bị tính trùng lặp", async () => {
  await Return_order.create({
    Return_order_id: "TEST_RET_EXTRA_001",
    Product_variant_id: "VAR_TEST",
    Order_id: "TEST_ORD_002",
    Product_variant_id: "VAR_EXTRA",
    Reason_type: "damaged",
    Refund_amount: 150000,
    Status: "completed",
  });

  const res = await callAdminCustomerDetail(managerToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  const stats = res.body.orderStats;

  assert.equal(stats.totalSpent, 1150000);

  await Return_order.deleteOne({ Return_order_id: "TEST_RET_EXTRA_001" });
});

test("DETAIL-16: Khách hàng chưa có Order -> orderStats trả về toàn 0", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_NO_DATA_ID);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.orderStats, {
    total: 0,
    completed: 0,
    processing: 0,
    cancelled: 0,
    totalSpent: 0,
  });
});

test("DETAIL-17: Không trả dữ liệu nhạy cảm trong response chi tiết", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_1_ID);
  assert.equal(res.statusCode, 200);
  const cust = res.body.customer;

  assert.equal(cust.Password, undefined);
  assert.equal(cust.Reset_otp, undefined);
  assert.equal(cust.Reset_otp_expires, undefined);
  assert.equal(cust.Admin_reset_otp_hash, undefined);
  assert.equal(cust.Admin_reset_otp_expires, undefined);
  assert.equal(cust.Admin_reset_otp_sent_at, undefined);
  assert.equal(cust.Admin_reset_otp_attempts, undefined);
  assert.equal(cust.Admin_reset_otp_locked_until, undefined);
});

// =========================================================================
// C. BỘ KIỂM THỬ GIAI ĐOẠN 2D: ĐỔI TRẢ MỘT PHẦN VÀ CÁC TRƯỜNG HỢP BIÊN
// =========================================================================

// Helper xóa fixture của riêng CUST_2D
async function resetCust2dData() {
  await Order.deleteMany({ User_id: { $in: [CUST_2D_ID, CUST_2D_OTHER_ID] } });
  await Return_order.deleteMany({ Order_id: /^TEST_ORD_2D_/ });
}

test("STAGE2D-01: Đơn delivered không có Return_order -> Tính 100% chi tiêu, thuộc completed", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_01",
    User_id: CUST_2D_ID,
    Total_amount: 800000,
    Total_items_price: 800000,
    Status: "delivered",
  });

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderStats.totalSpent, 800000);
  assert.equal(res.body.orderStats.completed, 1);
  assert.equal(res.body.orderStats.processing, 0);
  assert.equal(res.body.orderStats.cancelled, 0);
  assert.equal(res.body.orderStats.total, 1);
});

test("STAGE2D-02: Đơn delivered có Return_order completed -> Trừ tiền hoàn, thuộc completed", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_02",
    User_id: CUST_2D_ID,
    Total_amount: 1000000,
    Total_items_price: 1000000,
    Status: "delivered",
  });
  await Return_order.create({
    Return_order_id: "TEST_RET_2D_02",
    Product_variant_id: "VAR_TEST",
    Order_id: "TEST_ORD_2D_02",
    Refund_amount: 300000,
    Status: "completed",
    Reason_type: "defective",
  });

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderStats.totalSpent, 700000); // 1.000.000 - 300.000
  assert.equal(res.body.orderStats.completed, 1);
  assert.equal(res.body.orderStats.processing, 0);
});

test("STAGE2D-03: Đơn returning CHỈ CÓ một Return_order completed (hoàn một phần) -> Cộng phần giữ lại, thuộc completed", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_03",
    User_id: CUST_2D_ID,
    Total_amount: 1000000,
    Total_items_price: 1000000,
    Status: "returning",
  });
  await Return_order.create({
    Return_order_id: "TEST_RET_2D_03",
    Product_variant_id: "VAR_TEST",
    Order_id: "TEST_ORD_2D_03",
    Refund_amount: 400000,
    Status: "completed",
    Reason_type: "defective",
  });

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  // Khách giữ lại hàng trị giá 600.000 đ -> Phải tính vào totalSpent!
  assert.equal(res.body.orderStats.totalSpent, 600000);
  assert.equal(res.body.orderStats.completed, 1);
  assert.equal(res.body.orderStats.processing, 0);
});

test("STAGE2D-04: Đơn returning có completed + pending -> Tạm không tính chi tiêu, thuộc processing", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_04",
    User_id: CUST_2D_ID,
    Total_amount: 1000000,
    Total_items_price: 1000000,
    Status: "returning",
  });
  await Return_order.create([
    {
      Return_order_id: "TEST_RET_2D_04A",
      Product_variant_id: "VAR_TEST",
      Order_id: "TEST_ORD_2D_04",
      Refund_amount: 300000,
      Status: "completed",
      Reason_type: "defective",
    },
    {
      Return_order_id: "TEST_RET_2D_04B",
      Product_variant_id: "VAR_TEST",
      Order_id: "TEST_ORD_2D_04",
      Refund_amount: 200000,
      Status: "pending",
      Reason_type: "wrong_item",
    },
  ]);

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderStats.totalSpent, 0); // Đang xử lý dở dang, chưa chốt
  assert.equal(res.body.orderStats.processing, 1);
  assert.equal(res.body.orderStats.completed, 0);
});

test("STAGE2D-05: Đơn returning có completed + approved -> Tạm không tính chi tiêu, thuộc processing", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_05",
    User_id: CUST_2D_ID,
    Total_amount: 1000000,
    Total_items_price: 1000000,
    Status: "returning",
  });
  await Return_order.create([
    {
      Return_order_id: "TEST_RET_2D_05A",
      Product_variant_id: "VAR_TEST",
      Order_id: "TEST_ORD_2D_05",
      Refund_amount: 300000,
      Status: "completed",
      Reason_type: "defective",
    },
    {
      Return_order_id: "TEST_RET_2D_05B",
      Product_variant_id: "VAR_TEST",
      Order_id: "TEST_ORD_2D_05",
      Refund_amount: 200000,
      Status: "approved",
      Reason_type: "wrong_item",
    },
  ]);

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderStats.totalSpent, 0);
  assert.equal(res.body.orderStats.processing, 1);
  assert.equal(res.body.orderStats.completed, 0);
});

test("STAGE2D-06: Đơn returning có nhiều completed (không còn pending/approved) -> Trừ tổng các hoàn tiền, thuộc completed", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_06",
    User_id: CUST_2D_ID,
    Total_amount: 1000000,
    Total_items_price: 1000000,
    Status: "returning",
  });
  await Return_order.create([
    {
      Return_order_id: "TEST_RET_2D_06A",
      Product_variant_id: "VAR_TEST",
      Order_id: "TEST_ORD_2D_06",
      Refund_amount: 250000,
      Status: "completed",
      Reason_type: "defective",
    },
    {
      Return_order_id: "TEST_RET_2D_06B",
      Product_variant_id: "VAR_TEST",
      Order_id: "TEST_ORD_2D_06",
      Refund_amount: 350000,
      Status: "completed",
      Reason_type: "wrong_item",
    },
  ]);

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  // Khách giữ lại: 1.000.000 - (250.000 + 350.000) = 400.000 đ
  assert.equal(res.body.orderStats.totalSpent, 400000);
  assert.equal(res.body.orderStats.completed, 1);
  assert.equal(res.body.orderStats.processing, 0);
});

test("STAGE2D-07: Đơn returning có tất cả Return_order rejected -> Tính 100% giá trị đơn, thuộc completed", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_07",
    User_id: CUST_2D_ID,
    Total_amount: 500000,
    Total_items_price: 500000,
    Status: "returning",
  });
  await Return_order.create({
    Return_order_id: "TEST_RET_2D_07",
    Product_variant_id: "VAR_TEST",
    Order_id: "TEST_ORD_2D_07",
    Refund_amount: 500000,
    Status: "rejected",
    Reason_type: "changed_mind",
  });

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  // Toàn bộ yêu cầu bị từ chối -> Khách không được hoàn xu nào -> Chi tiêu là 500.000 đ
  assert.equal(res.body.orderStats.totalSpent, 500000);
  assert.equal(res.body.orderStats.completed, 1);
  assert.equal(res.body.orderStats.processing, 0);
});

test("STAGE2D-08: Đơn returning không có Return_order nào -> Không tính chi tiêu (0đ), thuộc processing", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_08",
    User_id: CUST_2D_ID,
    Total_amount: 500000,
    Total_items_price: 500000,
    Status: "returning",
  });

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderStats.totalSpent, 0);
  assert.equal(res.body.orderStats.processing, 1);
  assert.equal(res.body.orderStats.completed, 0);
});

test("STAGE2D-09: Đơn cancelled có Return_order completed (dữ liệu bất thường) -> Không tính chi tiêu (0đ), thuộc cancelled", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_09",
    User_id: CUST_2D_ID,
    Total_amount: 500000,
    Total_items_price: 500000,
    Status: "cancelled",
  });
  await Return_order.create({
    Return_order_id: "TEST_RET_2D_09",
    Product_variant_id: "VAR_TEST",
    Order_id: "TEST_ORD_2D_09",
    Refund_amount: 200000,
    Status: "completed",
    Reason_type: "defective",
  });

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderStats.totalSpent, 0);
  assert.equal(res.body.orderStats.cancelled, 1);
  assert.equal(res.body.orderStats.completed, 0);
  assert.equal(res.body.orderStats.processing, 0);
});

test("STAGE2D-10: Đơn returning hoàn tiền 100% (Refund_amount = Total_amount) -> totalSpent = 0, thuộc processing", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_10",
    User_id: CUST_2D_ID,
    Total_amount: 500000,
    Total_items_price: 500000,
    Status: "returning",
  });
  await Return_order.create({
    Return_order_id: "TEST_RET_2D_10",
    Product_variant_id: "VAR_TEST",
    Order_id: "TEST_ORD_2D_10",
    Refund_amount: 500000,
    Status: "completed",
    Reason_type: "defective",
  });

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  // Hoàn tiền 100% -> Khách không giữ hàng gì cả -> chi tiêu = 0 đ, phân loại processing (hậu mãi)
  assert.equal(res.body.orderStats.totalSpent, 0);
  assert.equal(res.body.orderStats.processing, 1);
  assert.equal(res.body.orderStats.completed, 0);
});

test("STAGE2D-11: Tổng Refund_amount lớn hơn Total_amount (dữ liệu sai lệch) -> totalSpent = 0 (bảo vệ không âm)", async () => {
  await resetCust2dData();
  await Order.create({
    Order_id: "TEST_ORD_2D_11",
    User_id: CUST_2D_ID,
    Total_amount: 500000,
    Total_items_price: 500000,
    Status: "delivered",
  });
  await Return_order.create({
    Return_order_id: "TEST_RET_2D_11",
    Product_variant_id: "VAR_TEST",
    Order_id: "TEST_ORD_2D_11",
    Refund_amount: 800000, // Lớn hơn 500k
    Status: "completed",
    Reason_type: "defective",
  });

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.orderStats.totalSpent, 0);
});

test("STAGE2D-12: Dữ liệu nhiều khách hàng, đảm bảo không lấy nhầm Return_order của khách khác", async () => {
  await resetCust2dData();
  // Khách A (CUST_2D_ID) mua đơn 500k
  await Order.create({
    Order_id: "TEST_ORD_2D_A",
    User_id: CUST_2D_ID,
    Total_amount: 500000,
    Total_items_price: 500000,
    Status: "delivered",
  });

  // Khách B (CUST_2D_OTHER_ID) mua đơn 1M và có khoản hoàn tiền 300k
  await Order.create({
    Order_id: "TEST_ORD_2D_B",
    User_id: CUST_2D_OTHER_ID,
    Total_amount: 1000000,
    Total_items_price: 1000000,
    Status: "delivered",
  });
  await Return_order.create({
    Return_order_id: "TEST_RET_2D_B",
    Product_variant_id: "VAR_TEST",
    Order_id: "TEST_ORD_2D_B",
    Refund_amount: 300000,
    Status: "completed",
    Reason_type: "defective",
  });

  // Xem chi tiết Khách A: Tiền hoàn 300k của Khách B TUYỆT ĐỐI KHÔNG được trừ vào Khách A
  const resA = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(resA.statusCode, 200);
  assert.equal(resA.body.orderStats.totalSpent, 500000);

  // Xem chi tiết Khách B: Khách B có chi tiêu = 1.000.000 - 300.000 = 700.000 đ
  const resB = await callAdminCustomerDetail(managerToken, CUST_2D_OTHER_ID);
  assert.equal(resB.statusCode, 200);
  assert.equal(resB.body.orderStats.totalSpent, 700000);
});

test("STAGE2D-13: Đảm bảo mỗi đơn chỉ được tính một lần trong orderStats (sum categories === total)", async () => {
  await resetCust2dData();
  // Tạo đồng thời nhiều loại đơn cho Khách A:
  // - 1 delivered (completed)
  // - 1 review (completed)
  // - 1 returning hoàn 1 phần (completed)
  // - 1 returning hoàn 100% (processing)
  // - 1 returning pending (processing)
  // - 1 shipping (processing)
  // - 1 cancelled (cancelled)
  await Order.create([
    { Order_id: "TEST_ORD_2D_T1", User_id: CUST_2D_ID, Total_amount: 100000, Total_items_price: 100000, Status: "delivered" },
    { Order_id: "TEST_ORD_2D_T2", User_id: CUST_2D_ID, Total_amount: 100000, Total_items_price: 100000, Status: "review" },
    { Order_id: "TEST_ORD_2D_T3", User_id: CUST_2D_ID, Total_amount: 200000, Total_items_price: 200000, Status: "returning" },
    { Order_id: "TEST_ORD_2D_T4", User_id: CUST_2D_ID, Total_amount: 150000, Total_items_price: 150000, Status: "returning" },
    { Order_id: "TEST_ORD_2D_T5", User_id: CUST_2D_ID, Total_amount: 300000, Total_items_price: 300000, Status: "returning" },
    { Order_id: "TEST_ORD_2D_T6", User_id: CUST_2D_ID, Total_amount: 250000, Total_items_price: 250000, Status: "shipping" },
    { Order_id: "TEST_ORD_2D_T7", User_id: CUST_2D_ID, Total_amount: 120000, Total_items_price: 120000, Status: "cancelled" },
  ]);

  await Return_order.create([
    // T3: hoàn 50k / 200k (completed một phần)
    { Return_order_id: "TEST_RET_2D_T3", Product_variant_id: "VAR_TEST", Order_id: "TEST_ORD_2D_T3", Refund_amount: 50000, Status: "completed", Reason_type: "defective" },
    // T4: hoàn 150k / 150k (hoàn 100%)
    { Return_order_id: "TEST_RET_2D_T4", Product_variant_id: "VAR_TEST", Order_id: "TEST_ORD_2D_T4", Refund_amount: 150000, Status: "completed", Reason_type: "defective" },
    // T5: đang pending
    { Return_order_id: "TEST_RET_2D_T5", Product_variant_id: "VAR_TEST", Order_id: "TEST_ORD_2D_T5", Refund_amount: 100000, Status: "pending", Reason_type: "defective" },
  ]);

  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  const stats = res.body.orderStats;

  assert.equal(stats.total, 7);
  assert.equal(stats.completed, 3); // T1, T2, T3
  assert.equal(stats.processing, 3); // T4, T5, T6
  assert.equal(stats.cancelled, 1);  // T7
  assert.equal(stats.completed + stats.processing + stats.cancelled, stats.total);
});

test("STAGE2D-14: Kiểm tra response không làm lộ Password/OTP trong mọi trường hợp", async () => {
  const res = await callAdminCustomerDetail(managerToken, CUST_2D_ID);
  assert.equal(res.statusCode, 200);
  const cust = res.body.customer;

  assert.equal(cust.Password, undefined);
  assert.equal(cust.Reset_otp, undefined);
  assert.equal(cust.Admin_reset_otp_hash, undefined);
});

// =========================================================================
// D. BỘ KIỂM THỬ GIAI ĐOẠN 3: KHÓA / MỞ KHÓA TÀI KHOẢN KHÁCH HÀNG (27 TEST CASES)
// =========================================================================

// Fixture User riêng cho Giai đoạn 3
const CUST_3_ID = "TEST_ADM_CUST_G3";

async function ensureCust3Fixture() {
  await User.deleteOne({ User_id: CUST_3_ID });
  const hashedPass = await bcrypt.hash("PassG3@123", 10);
  await User.create({
    User_id: CUST_3_ID,
    Username: "test_cust_g3",
    Email: "cust_g3@vista.test.local",
    Password: hashedPass,
    Full_name: "Khách Hàng Giai Đoạn 3",
    Phone_number: "0933445566",
    Role: "Customer",
    Status: "active",
    Total_spent: 500000,
    Failed_Login_Count: 0,
    Locked_Until: null,
  });
}

// 1. Phân quyền (1 -> 9)
test("STAGE3-01: Manager khóa được tài khoản Customer thành công", async () => {
  await ensureCust3Fixture();
  const res = await callAdminCustomerLock(managerToken, CUST_3_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.customer.Status, "blocked");

  // Kiểm tra database
  const dbUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(dbUser.Status, "blocked");
});

test("STAGE3-02: Manager mở khóa được tài khoản Customer thành công", async () => {
  // Bắt đầu từ trạng thái blocked
  await User.updateOne({ User_id: CUST_3_ID }, { $set: { Status: "blocked" } });

  const res = await callAdminCustomerUnlock(managerToken, CUST_3_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.customer.Status, "active");

  // Kiểm tra database
  const dbUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(dbUser.Status, "active");
});

test("STAGE3-03: Staff không có quyền khóa Customer (403 Forbidden)", async () => {
  await ensureCust3Fixture();
  const res = await callAdminCustomerLock(staffToken, CUST_3_ID);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);

  // Database không đổi
  const dbUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(dbUser.Status, "active");
});

test("STAGE3-04: Staff không có quyền mở khóa Customer (403 Forbidden)", async () => {
  await User.updateOne({ User_id: CUST_3_ID }, { $set: { Status: "blocked" } });
  const res = await callAdminCustomerUnlock(staffToken, CUST_3_ID);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);

  // Database không đổi
  const dbUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(dbUser.Status, "blocked");
});

test("STAGE3-05: Customer không có quyền gọi API lock/unlock (403 Forbidden)", async () => {
  const resLock = await callAdminCustomerLock(customerToken, CUST_3_ID);
  assert.equal(resLock.statusCode, 403);
  assert.equal(resLock.body.success, false);

  const resUnlock = await callAdminCustomerUnlock(customerToken, CUST_3_ID);
  assert.equal(resUnlock.statusCode, 403);
  assert.equal(resUnlock.body.success, false);
});

test("STAGE3-06: Request không token bị từ chối (401 Unauthorized)", async () => {
  const resLock = await callAdminCustomerLock(null, CUST_3_ID);
  assert.equal(resLock.statusCode, 401);
  assert.equal(resLock.body.success, false);

  const resUnlock = await callAdminCustomerUnlock(null, CUST_3_ID);
  assert.equal(resUnlock.statusCode, 401);
  assert.equal(resUnlock.body.success, false);
});

test("STAGE3-07: Manager không thể khóa tài khoản Manager khác -> 404 Not Found", async () => {
  const res = await callAdminCustomerLock(managerToken, MGR_ID);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Không tìm thấy khách hàng/);

  // DB Manager vẫn active
  const dbMgr = await User.findOne({ User_id: MGR_ID }).lean();
  assert.equal(dbMgr.Status, "active");
});

test("STAGE3-08: Manager không thể khóa tài khoản Staff -> 404 Not Found", async () => {
  const res = await callAdminCustomerLock(managerToken, STF_ID);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Không tìm thấy khách hàng/);

  // DB Staff vẫn active
  const dbStf = await User.findOne({ User_id: STF_ID }).lean();
  assert.equal(dbStf.Status, "active");
});

test("STAGE3-09: Manager không thể mở khóa tài khoản Manager hoặc Staff -> 404 Not Found", async () => {
  const resMgr = await callAdminCustomerUnlock(managerToken, MGR_ID);
  assert.equal(resMgr.statusCode, 404);

  const resStf = await callAdminCustomerUnlock(managerToken, STF_ID);
  assert.equal(resStf.statusCode, 404);
});

// 2. Trạng thái (10 -> 16)
test("STAGE3-10: Khóa Customer đang active -> Chuyển thành blocked thành công", async () => {
  await ensureCust3Fixture();
  const res = await callAdminCustomerLock(managerToken, CUST_3_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customer.Status, "blocked");
});

test("STAGE3-11: Khóa Customer đã blocked -> Xử lý an toàn, không cập nhật dư thừa", async () => {
  await User.updateOne({ User_id: CUST_3_ID }, { $set: { Status: "blocked" } });
  const res = await callAdminCustomerLock(managerToken, CUST_3_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customer.Status, "blocked");
  assert.match(res.body.message, /đã ở trạng thái bị khóa/);
});

test("STAGE3-12: Mở khóa Customer đang blocked -> Chuyển thành active thành công", async () => {
  await User.updateOne({ User_id: CUST_3_ID }, { $set: { Status: "blocked" } });
  const res = await callAdminCustomerUnlock(managerToken, CUST_3_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customer.Status, "active");
});

test("STAGE3-13: Mở khóa Customer đã active -> Xử lý an toàn, không cập nhật dư thừa", async () => {
  await ensureCust3Fixture();
  const res = await callAdminCustomerUnlock(managerToken, CUST_3_ID);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customer.Status, "active");
  assert.match(res.body.message, /đã ở trạng thái hoạt động/);
});

test("STAGE3-14: User_id không tồn tại -> 404 Not Found", async () => {
  const res = await callAdminCustomerLock(managerToken, "NON_EXISTENT_USR_99999");
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
});

test("STAGE3-15: Không truyền Status trong body vẫn hoạt động chuẩn xác theo endpoint", async () => {
  await ensureCust3Fixture();
  const res = await callAdminCustomerLock(managerToken, CUST_3_ID, {});
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customer.Status, "blocked");
});

test("STAGE3-16: Truyền Status giả mạo trong body không làm thay đổi kết quả endpoint", async () => {
  await ensureCust3Fixture();
  // Gọi endpoint /lock nhưng truyền body cố tình ghi { Status: "active", Role: "Manager" }
  const res = await callAdminCustomerLock(managerToken, CUST_3_ID, {
    Status: "active",
    Role: "Manager",
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.customer.Status, "blocked"); // Vẫn bị khóa theo đúng endpoint!

  const dbUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(dbUser.Status, "blocked");
  assert.equal(dbUser.Role, "Customer"); // Role không đổi
});

// 3. Bảo toàn dữ liệu (17 -> 23)
test("STAGE3-17: Khóa tài khoản không làm mất đơn hàng của khách", async () => {
  await ensureCust3Fixture();
  await Order.create({
    Order_id: "TEST_ORD_G3_01",
    User_id: CUST_3_ID,
    Total_amount: 300000,
    Total_items_price: 300000,
    Status: "processing",
  });

  await callAdminCustomerLock(managerToken, CUST_3_ID);

  const orders = await Order.find({ User_id: CUST_3_ID }).lean();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].Order_id, "TEST_ORD_G3_01");
});

test("STAGE3-18: Khóa tài khoản không làm mất địa chỉ của khách", async () => {
  await ensureCust3Fixture();
  await Address.create({
    Address_id: "TEST_ADDR_G3_01",
    User_id: CUST_3_ID,
    Receiver_name: "Khách G3",
    Receiver_phone: "0933445566",
    Email: "cust_g3@vista.test.local",
    Province: "Hà Nội",
    District: "Hoàn Kiếm",
    Ward: "Hàng Trống",
    Specific_address: "12 Nhà Chung",
  });

  await callAdminCustomerLock(managerToken, CUST_3_ID);

  const addrs = await Address.find({ User_id: CUST_3_ID }).lean();
  assert.equal(addrs.length, 1);
  assert.equal(addrs[0].Address_id, "TEST_ADDR_G3_01");
});

test("STAGE3-19: Khóa tài khoản không làm mất lịch sử đổi trả", async () => {
  await ensureCust3Fixture();
  await Return_order.create({
    Return_order_id: "TEST_RET_G3_01",
    Product_variant_id: "VAR_TEST",
    Order_id: "TEST_ORD_G3_01",
    Refund_amount: 150000,
    Status: "completed",
    Reason_type: "defective",
  });

  await callAdminCustomerLock(managerToken, CUST_3_ID);

  const rets = await Return_order.find({ Order_id: "TEST_ORD_G3_01" }).lean();
  assert.equal(rets.length, 1);
  assert.equal(rets[0].Return_order_id, "TEST_RET_G3_01");
});

test("STAGE3-20: Khóa/mở khóa không làm thay đổi Password hash trong DB", async () => {
  await ensureCust3Fixture();
  const beforeUser = await User.findOne({ User_id: CUST_3_ID }).lean();

  await callAdminCustomerLock(managerToken, CUST_3_ID);
  await callAdminCustomerUnlock(managerToken, CUST_3_ID);

  const afterUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(afterUser.Password, beforeUser.Password);
});

test("STAGE3-21: Khóa/mở khóa không thay đổi Role (vẫn là Customer)", async () => {
  await ensureCust3Fixture();
  await callAdminCustomerLock(managerToken, CUST_3_ID);
  let dbUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(dbUser.Role, "Customer");

  await callAdminCustomerUnlock(managerToken, CUST_3_ID);
  dbUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(dbUser.Role, "Customer");
});

test("STAGE3-22: Không làm lộ OTP hoặc thông tin bảo mật trong response", async () => {
  await ensureCust3Fixture();
  const res = await callAdminCustomerLock(managerToken, CUST_3_ID);
  assert.equal(res.statusCode, 200);
  const cust = res.body.customer;

  assert.equal(cust.Password, undefined);
  assert.equal(cust.Reset_otp, undefined);
  assert.equal(cust.Admin_reset_otp_hash, undefined);
});

test("STAGE3-23: Khóa/mở khóa không thay đổi Total_spent trong DB", async () => {
  await ensureCust3Fixture();
  const beforeUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(beforeUser.Total_spent, 500000);

  await callAdminCustomerLock(managerToken, CUST_3_ID);
  await callAdminCustomerUnlock(managerToken, CUST_3_ID);

  const afterUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  assert.equal(afterUser.Total_spent, 500000);
});

// 4. Kiểm tra authentication (24 -> 27)
test("STAGE3-24: Khách đang đăng nhập bị chặn ngay ở request tiếp theo sau khi bị khóa (403)", async () => {
  await ensureCust3Fixture();

  // Khách tạo token hợp lệ
  const activeCustomerToken = jwt.sign(
    { User_id: CUST_3_ID, Email: "cust_g3@vista.test.local", Role: "Customer" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  // Trước khi khóa: gọi API /me thành công 200
  let resMe = await callCustomerMe(activeCustomerToken);
  assert.equal(resMe.statusCode, 200);

  // Manager tiến hành khóa tài khoản
  await callAdminCustomerLock(managerToken, CUST_3_ID);

  // Ngay request tiếp theo: gọi lại với cùng token đó -> Bị authMiddleware chặn 403!
  resMe = await callCustomerMe(activeCustomerToken);
  assert.equal(resMe.statusCode, 403);
  assert.equal(resMe.body.success, false);
  assert.match(resMe.body.message, /Tài khoản đã bị khóa/);
});

test("STAGE3-25: Sau khi mở khóa, xác minh chính xác token cũ còn hạn hoạt động bình thường trở lại", async () => {
  // Token tạo trước đó vẫn còn hạn
  const customerTokenG3 = jwt.sign(
    { User_id: CUST_3_ID, Email: "cust_g3@vista.test.local", Role: "Customer" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );

  // Đang bị khóa -> 403
  let resMe = await callCustomerMe(customerTokenG3);
  assert.equal(resMe.statusCode, 403);

  // Manager mở khóa tài khoản
  await callAdminCustomerUnlock(managerToken, CUST_3_ID);

  // Gọi lại bằng CHÍNH TOKEN CŨ -> Thành công 200 OK!
  resMe = await callCustomerMe(customerTokenG3);
  assert.equal(resMe.statusCode, 200);
  assert.equal(resMe.body.success, true);
  assert.equal(resMe.body.data.User_id, CUST_3_ID);
});

test("STAGE3-26: Token hết hạn vẫn bị từ chối với 401 Unauthorized", async () => {
  // Token đã hết hạn từ 10 giây trước
  const expiredToken = jwt.sign(
    { User_id: CUST_3_ID, Email: "cust_g3@vista.test.local", Role: "Customer" },
    process.env.JWT_SECRET,
    { expiresIn: "-10s" }
  );

  const res = await callCustomerMe(expiredToken);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /Token không hợp lệ hoặc đã hết hạn/);
});

test("STAGE3-27: Khách đăng nhập lại sau khi mở khóa hoạt động chuẩn xác theo logic hiện tại", async () => {
  const dbUser = await User.findOne({ User_id: CUST_3_ID }).lean();
  // Mật khẩu vẫn khớp
  const isMatch = await bcrypt.compare("PassG3@123", dbUser.Password);
  assert.equal(isMatch, true);

  // Sinh token mới như flow login và gọi API thành công
  const freshToken = jwt.sign(
    { User_id: dbUser.User_id, Email: dbUser.Email, Role: dbUser.Role },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  const resMe = await callCustomerMe(freshToken);
  assert.equal(resMe.statusCode, 200);
  assert.equal(resMe.body.data.Status, "active");
});
