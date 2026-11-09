const test = require("node:test");
const assert = require("node:assert/strict");

const authMiddleware = require("../middleware/auth.middleware");
const promotionController = require("../controllers/admin/promotion.controller");
const voucherController = require("../controllers/voucher.controller");
const { Voucher, Order } = require("../models/schema");
const {
  parseVoucherDateTime,
  formatDateToVNISO,
  extractLegacyDiscountInfo,
  resolvePromotionStatus,
  VOUCHER_COUNTED_ORDER_STATUSES,
} = require("../services/promotion-helper");

function mockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test("Role permission middleware properly enforces Manager and Staff access", () => {
  const managerOnly = authMiddleware.requireRole("Manager");
  const managerAndStaff = authMiddleware.requireRole("Manager", "Staff");

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  // Test Manager calling Manager-only route
  nextCalled = false;
  let res = mockResponse();
  managerOnly({ user: { Role: "Manager" } }, res, next);
  assert.equal(nextCalled, true, "Manager must pass Manager-only route");

  // Test Staff calling Manager-only route (Must be 403 Forbidden)
  nextCalled = false;
  res = mockResponse();
  managerOnly({ user: { Role: "Staff" } }, res, next);
  assert.equal(nextCalled, false, "Staff must be blocked from Manager-only route");
  assert.equal(res.statusCode, 403, "Staff should receive 403 status code");
  assert.equal(res.body.success, false);

  // Test Staff calling Manager & Staff route (Allowed)
  nextCalled = false;
  res = mockResponse();
  managerAndStaff({ user: { Role: "Staff" } }, res, next);
  assert.equal(nextCalled, true, "Staff must be allowed to read Manager & Staff routes");

  // Test Customer calling Manager & Staff route (Blocked)
  nextCalled = false;
  res = mockResponse();
  managerAndStaff({ user: { Role: "Customer" } }, res, next);
  assert.equal(nextCalled, false, "Customer must be blocked");
  assert.equal(res.statusCode, 403);
});

test("Promotion detail falls back to the stored usage count when no orders are found", async () => {
  const originalFindById = Voucher.findById;
  const originalCountDocuments = Order.countDocuments;
  const originalAggregate = Order.aggregate;

  Voucher.findById = () => ({
    lean: async () => ({
      _id: "507f1f77bcf86cd799439011",
      code: "SAVE100",
      title: "Giảm giá",
      type: "fixed_amount",
      status: "active",
      startDate: "2026-01-01",
      endDate: "2099-12-31",
      expiry: "2099-12-31",
      usage_limit: 10000,
      used_count: 5,
    }),
  });
  Order.countDocuments = async () => 0;
  Order.aggregate = async () => [];

  try {
    const res = mockResponse();
    await promotionController.getPromotionById(
      { params: { id: "507f1f77bcf86cd799439011" } },
      res
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.usedCount, 5);
  } finally {
    Voucher.findById = originalFindById;
    Order.countDocuments = originalCountDocuments;
    Order.aggregate = originalAggregate;
  }
});

test("Promotion date filters return the matching active, upcoming, and unexpired vouchers", async () => {
  const originalFind = Voucher.find;
  const originalCountDocuments = Voucher.countDocuments;
  const originalAggregate = Order.aggregate;
  const vouchers = [
    {
      _id: "507f1f77bcf86cd799439011",
      code: "ACTIVE",
      title: "Đang diễn ra",
      type: "fixed_amount",
      status: "active",
      startDate: "01/01/2020",
      endDate: "31/12/2099",
      expiry: "31/12/2099",
    },
    {
      _id: "507f1f77bcf86cd799439012",
      code: "UPCOMING",
      title: "Sắp diễn ra",
      type: "fixed_amount",
      status: "active",
      startDate: "01/01/2099",
      endDate: "31/12/2099",
      expiry: "31/12/2099",
    },
    {
      _id: "507f1f77bcf86cd799439013",
      code: "EXPIRED",
      title: "Đã kết thúc",
      type: "fixed_amount",
      status: "active",
      startDate: "01/01/2020",
      endDate: "02/01/2020",
      expiry: "02/01/2020",
    },
  ];

  Voucher.find = () => ({
    sort() {
      return this;
    },
    lean: async () => vouchers,
  });
  Voucher.countDocuments = async () => vouchers.length;
  Order.aggregate = async () => [];

  try {
    const getCodes = async (dateFilter) => {
      const res = mockResponse();
      await promotionController.getPromotions({ query: { dateFilter } }, res);
      assert.equal(res.statusCode, 200);
      return res.body.data.items.map((item) => item.code);
    };

    assert.deepEqual(await getCodes("today"), ["ACTIVE"]);
    assert.deepEqual(await getCodes("7days"), ["ACTIVE", "UPCOMING"]);
    assert.deepEqual(await getCodes("30days"), ["ACTIVE", "UPCOMING"]);
  } finally {
    Voucher.find = originalFind;
    Voucher.countDocuments = originalCountDocuments;
    Order.aggregate = originalAggregate;
  }
});

test("Promotion validation rejects invalid codes, discount values, and date ranges", async () => {
  // Test code format validation
  let req = { body: { code: "ab", title: "Khuyến mãi hè", type: "percent", discountValue: 20, endDate: "2026-12-31" } };
  let res = mockResponse();
  await promotionController.createPromotion(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Mã khuyến mãi phải từ 3-20 ký tự/);

  // Test discountValue <= 0
  req = { body: { code: "HE2026", title: "Khuyến mãi hè", type: "percent", discountValue: 0, endDate: "2026-12-31" } };
  res = mockResponse();
  await promotionController.createPromotion(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Mức giảm giá phải lớn hơn 0/);

  // Test percent discountValue > 100
  req = { body: { code: "HE2026", title: "Khuyến mãi hè", type: "percent", discountValue: 150, endDate: "2026-12-31" } };
  res = mockResponse();
  await promotionController.createPromotion(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /không được vượt quá 100%/);

  // Test endDate < startDate
  req = {
    body: {
      code: "HE2026",
      title: "Khuyến mãi hè",
      type: "fixed_amount",
      discountValue: 50000,
      startDate: "2026-12-31",
      endDate: "2026-01-01",
    },
  };
  res = mockResponse();
  await promotionController.createPromotion(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Ngày kết thúc phải sau hoặc bằng ngày bắt đầu/);

  // Test specific_categories without selecting any category
  req = {
    body: {
      code: "HE2026",
      title: "Khuyến mãi hè",
      type: "fixed_amount",
      discountValue: 50000,
      scope: "specific_categories",
      applicableCategories: [],
      endDate: "2026-12-31",
    },
  };
  res = mockResponse();
  await promotionController.createPromotion(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /chọn ít nhất một danh mục/);
});

test("Promotion Status Precedence and Vietnamese Labels", () => {
  const now = new Date("2026-06-01T12:00:00+07:00");
  const pastDate = "2025-01-01T00:00:00+07:00";
  const futureDate = "2099-01-01T00:00:00+07:00";

  // 1. Bản nháp
  let res = resolvePromotionStatus({ status: "draft" }, 0, now);
  assert.equal(res.status, "draft");
  assert.equal(res.statusLabel, "Bản nháp");

  // 2. Đã tạm dừng (ưu tiên hơn cả quá hạn!)
  res = resolvePromotionStatus({ status: "paused", endDate: pastDate }, 0, now);
  assert.equal(res.status, "paused");
  assert.equal(res.statusLabel, "Đã tạm dừng");

  // 3. Đã kết thúc
  res = resolvePromotionStatus({ status: "active", startDate: "2025-01-01", endDate: pastDate }, 0, now);
  assert.equal(res.status, "expired");
  assert.equal(res.statusLabel, "Đã kết thúc");

  // 4. Đã hết lượt
  res = resolvePromotionStatus({ status: "active", usage_limit: 10, startDate: "2026-01-01", endDate: futureDate }, 10, now);
  assert.equal(res.status, "out_of_quota");
  assert.equal(res.statusLabel, "Đã hết lượt");

  // 5. Sắp diễn ra
  res = resolvePromotionStatus({ status: "active", startDate: futureDate, endDate: futureDate }, 0, now);
  assert.equal(res.status, "upcoming");
  assert.equal(res.statusLabel, "Sắp diễn ra");

  // 6. Đang diễn ra
  res = resolvePromotionStatus({ status: "active", startDate: "2026-01-01", endDate: futureDate, usage_limit: 50 }, 20, now);
  assert.equal(res.status, "active");
  assert.equal(res.statusLabel, "Đang diễn ra");
  assert.equal(res.isUsable, true);
});

test("Legacy Voucher Extractor extracts correct discount values from text", () => {
  const voucherLegacy = {
    title: "Giảm 30K",
    condition: "Cho đơn hàng từ 2.000.000",
    type: "shipping",
    benefits: ["Giảm trực tiếp 30.000đ phí vận chuyển."],
    discountValue: 0,
    minOrderValue: 0,
    maxDiscountAmount: 0,
  };

  const extracted = extractLegacyDiscountInfo(voucherLegacy);
  assert.equal(extracted.discountValue, 30000);
  assert.equal(extracted.minOrderValue, 2000000);
});

test("VOUCHER_COUNTED_ORDER_STATUSES excludes cancelled orders", () => {
  assert.equal(VOUCHER_COUNTED_ORDER_STATUSES.includes("cancelled"), false, "Cancelled orders must NOT be counted");
  assert.equal(VOUCHER_COUNTED_ORDER_STATUSES.includes("processing"), true);
  assert.equal(VOUCHER_COUNTED_ORDER_STATUSES.includes("delivered"), true);
  assert.equal(VOUCHER_COUNTED_ORDER_STATUSES.includes("pending_payment"), true);
});

test("Customer voucher controller enforces paused status and date check", async () => {
  // Test paused voucher
  let voucher = {
    code: "PAUSED10",
    status: "paused",
    startDate: "01/01/2026",
    expiry: "31/12/2026",
  };
  await assert.rejects(
    async () => {
      await voucherController.assertVoucherCanBeUsed(voucher, {
        userId: "U01",
        totalItemsPrice: 500000,
        totalQuantity: 1,
      });
    },
    (err) => {
      assert.match(err.message, /tạm ngừng/);
      return true;
    }
  );

  // Test draft voucher
  voucher = {
    code: "DRAFT10",
    status: "draft",
    startDate: "01/01/2026",
    expiry: "31/12/2026",
  };
  await assert.rejects(
    async () => {
      await voucherController.assertVoucherCanBeUsed(voucher, {
        userId: "U01",
        totalItemsPrice: 500000,
        totalQuantity: 1,
      });
    },
    (err) => {
      assert.match(err.message, /chưa được phát hành/);
      return true;
    }
  );

  // Test voucher with future startDate
  voucher = {
    code: "FUTURE10",
    status: "active",
    startDate: "31/12/2099",
    expiry: "31/12/2099",
  };
  await assert.rejects(
    async () => {
      await voucherController.assertVoucherCanBeUsed(voucher, {
        userId: "U01",
        totalItemsPrice: 500000,
        totalQuantity: 1,
      });
    },
    (err) => {
      assert.match(err.message, /chưa bắt đầu/);
      return true;
    }
  );

  // 11. Customer checkout: Voucher legacy DD/MM/YYYY hợp lệ vẫn vượt qua assertVoucherCanBeUsed
  const validLegacyVoucher = {
    code: "VISTA10",
    title: "Giảm 10%",
    type: "percent",
    category: "discount",
    status: "available",
    startDate: "01/01/2026",
    expiry: "31/12/2026",
    minOrderValue: 5000000,
  };
  await assert.doesNotReject(async () => {
    await voucherController.assertVoucherCanBeUsed(validLegacyVoucher, {
      userId: "U01",
      totalItemsPrice: 6000000,
      totalQuantity: 2,
    });
  }, "Voucher legacy hợp lệ phải áp dụng thành công trong luồng khách hàng");
});
