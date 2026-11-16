const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseVoucherDateTime,
  formatDateToVNISO,
  extractLegacyDiscountInfo,
  resolvePromotionStatus,
} = require("../services/promotion-helper");

test("1. Voucher percent có discountValue tường minh", () => {
  const voucher = {
    code: "PERCENT_DIRECT",
    title: "Giảm 25%",
    type: "percent",
    discountValue: 25,
    maxDiscountAmount: 150000,
    minOrderValue: 200000,
  };
  const res = extractLegacyDiscountInfo(voucher);
  assert.equal(res.discountValue, 25);
  assert.equal(res.maxDiscountAmount, 150000);
  assert.equal(res.minOrderValue, 200000);
  assert.equal(res.normalizedType, "percent");
  assert.equal(res.warning, "");
});

test("2. Voucher percent legacy lấy dữ liệu từ benefits", () => {
  const voucher = {
    code: "VISTA10",
    title: "Giảm 10%",
    type: "percent",
    benefits: ["Giảm 10% giá trị đơn hàng.", "Giảm tối đa 500.000đ."],
    condition: "Cho đơn hàng từ 5.000.000đ",
  };
  const res = extractLegacyDiscountInfo(voucher);
  assert.equal(res.discountValue, 10);
  assert.equal(res.maxDiscountAmount, 500000);
  assert.equal(res.minOrderValue, 5000000);
  assert.equal(res.normalizedType, "percent");
});

test("3. Voucher fixed/fixed_amount và chuẩn hóa alias 'fixed'", () => {
  // Chuẩn fixed_amount
  const voucher1 = {
    code: "FIXED_STD",
    title: "Giảm 50K",
    type: "fixed_amount",
    discountValue: 50000,
    minOrderValue: 300000,
  };
  const res1 = extractLegacyDiscountInfo(voucher1);
  assert.equal(res1.discountValue, 50000);
  assert.equal(res1.normalizedType, "fixed_amount");

  // Alias 'fixed'
  const voucher2 = {
    code: "FIXED_ALIAS",
    title: "Giảm 25.000đ",
    type: "fixed",
    benefits: ["Giảm trực tiếp 25.000đ."],
  };
  const res2 = extractLegacyDiscountInfo(voucher2);
  assert.equal(res2.discountValue, 25000);
  assert.equal(res2.normalizedType, "fixed_amount");
});

test("4. Voucher Freeship có mức giảm tối đa", () => {
  const voucher = {
    code: "VISTA30",
    title: "Giảm 30K",
    type: "shipping",
    category: "freeship",
    benefits: ["Giảm trực tiếp 30.000đ phí vận chuyển.", "Giảm tối đa 30.000đ."],
  };
  const res = extractLegacyDiscountInfo(voucher);
  assert.equal(res.normalizedType, "free_shipping");
  assert.equal(res.maxDiscountAmount, 30000);
});

test("5. Voucher Freeship không có mức giảm tối đa (Uncapped Freeship)", () => {
  const voucher = {
    code: "FREESHIP",
    title: "Freeship toàn quốc",
    type: "shipping",
    category: "freeship",
    benefits: ["Miễn phí vận chuyển cho đơn hàng hợp lệ."],
  };
  const res = extractLegacyDiscountInfo(voucher);
  assert.equal(res.normalizedType, "free_shipping");
  assert.equal(res.maxDiscountAmount, 0);
  assert.equal(res.discountValue, 0);
});

test("6. Voucher có type và benefits mâu thuẫn (LAPTOP150 và percent có tiền mặt)", () => {
  // Case A: LAPTOP150 đã xác minh từ seed và checkout logic
  const laptopVoucher = {
    code: "LAPTOP150",
    title: "Giảm 150.000đ Laptop",
    type: "percent",
    benefits: ["Giảm trực tiếp 150.000đ."],
  };
  const resLaptop = extractLegacyDiscountInfo(laptopVoucher);
  assert.equal(resLaptop.normalizedType, "fixed_amount");
  assert.equal(resLaptop.discountValue, 150000);
  assert.match(resLaptop.warning, /LAPTOP150/);

  // Case B: Voucher khác có type percent nhưng chỉ có tiền mặt trong text -> ghi nhận cảnh báo, không tự đổi type
  const conflictVoucher = {
    code: "OTHER_CONFLICT",
    title: "Ưu đãi tiền mặt",
    type: "percent",
    benefits: ["Giảm 100.000đ vào tổng đơn."],
  };
  const resConflict = extractLegacyDiscountInfo(conflictVoucher);
  assert.equal(resConflict.normalizedType, "percent");
  assert.equal(resConflict.discountValue, 0);
  assert.match(resConflict.warning, /Voucher khai báo type percent nhưng nội dung mô tả chứa số tiền mặt/);
});

test("7. Voucher legacy available, expiring, used, expired", () => {
  const now = new Date("2026-06-01T12:00:00+07:00");
  const future = "2026-12-31T23:59:59+07:00";
  const past = "2025-12-31T23:59:59+07:00";

  // available -> active
  const availRes = resolvePromotionStatus({ status: "available", startDate: "01/01/2026", expiry: "31/12/2026" }, 0, now);
  assert.equal(availRes.status, "active");
  assert.equal(availRes.statusLabel, "Đang diễn ra");

  // expiring -> active với nhãn 'Sắp hết hạn'
  const expRes = resolvePromotionStatus({ status: "expiring", startDate: "01/01/2026", expiry: "31/12/2026" }, 0, now);
  assert.equal(expRes.status, "active");
  assert.equal(expRes.statusLabel, "Sắp hết hạn");
  assert.equal(expRes.isExpiringSoon, true);

  // used -> chuẩn hóa sang 'out_of_quota', nhãn 'Đã hết lượt'
  const usedRes = resolvePromotionStatus({ status: "used", startDate: "01/01/2026", expiry: "31/12/2026" }, 0, now);
  assert.equal(usedRes.status, "out_of_quota");
  assert.equal(usedRes.statusLabel, "Đã hết lượt");

  // expired -> quá hạn thời gian
  const expiredRes = resolvePromotionStatus({ status: "available", startDate: "01/01/2025", expiry: "31/12/2025" }, 0, now);
  assert.equal(expiredRes.status, "expired");
  assert.equal(expiredRes.statusLabel, "Đã kết thúc");
});

test("8. Đủ 6 trạng thái vòng đời chuẩn: draft, paused, upcoming, active, expired, out_of_quota", () => {
  const now = new Date("2026-06-01T12:00:00+07:00");
  const future = "2099-01-01T00:00:00+07:00";
  const past = "2020-01-01T00:00:00+07:00";

  // draft
  assert.equal(resolvePromotionStatus({ status: "draft" }, 0, now).status, "draft");

  // paused (ưu tiên hơn cả ngày quá hạn)
  assert.equal(resolvePromotionStatus({ status: "paused", expiry: past }, 0, now).status, "paused");

  // upcoming
  assert.equal(resolvePromotionStatus({ status: "active", startDate: future, expiry: future }, 0, now).status, "upcoming");

  // active
  assert.equal(resolvePromotionStatus({ status: "active", startDate: "01/01/2026", expiry: future }, 0, now).status, "active");

  // expired
  assert.equal(resolvePromotionStatus({ status: "active", startDate: "01/01/2020", expiry: past }, 0, now).status, "expired");

  // out_of_quota (chỉ khi usage_limit > 0 và used_count >= usage_limit)
  assert.equal(resolvePromotionStatus({ status: "active", usage_limit: 10, startDate: "01/01/2026", expiry: future }, 10, now).status, "out_of_quota");
});

test("9. Ngày bắt đầu và kết thúc theo múi giờ GMT+7 Asia/Ho_Chi_Minh", () => {
  // Legacy DD/MM/YYYY không giờ -> đầu ngày 00:00:00 GMT+7
  const start = parseVoucherDateTime("01/01/2026", false);
  assert.equal(start.toISOString(), "2025-12-31T17:00:00.000Z");

  // Legacy DD/MM/YYYY không giờ -> cuối ngày 23:59:59.999 GMT+7
  const end = parseVoucherDateTime("31/12/2026", true);
  assert.equal(end.toISOString(), "2026-12-31T16:59:59.999Z");

  // Chuỗi ISO đầy đủ
  const isoWithOffset = parseVoucherDateTime("2026-06-15T14:30:00+07:00");
  assert.equal(isoWithOffset.toISOString(), "2026-06-15T07:30:00.000Z");

  // Format sang VN ISO
  const formatted = formatDateToVNISO(isoWithOffset);
  assert.equal(formatted, "2026-06-15T14:30");
});

test("10. Lượt sử dụng không giới hạn (usage_limit = 0) và có giới hạn", () => {
  const now = new Date("2026-06-01T12:00:00+07:00");
  const future = "2099-01-01T00:00:00+07:00";

  // Khi usage_limit = 0: used_count dù đạt 10 hay 100 đơn vẫn KHÔNG bị out_of_quota
  const unlimitedRes = resolvePromotionStatus(
    { status: "active", usage_limit: 0, startDate: "01/01/2026", expiry: future },
    15,
    now
  );
  assert.equal(unlimitedRes.status, "active", "Voucher không giới hạn quota phải luôn active khi còn hạn");

  // Khi usage_limit = 10: used_count = 9 -> active
  const limitedActive = resolvePromotionStatus(
    { status: "active", usage_limit: 10, startDate: "01/01/2026", expiry: future },
    9,
    now
  );
  assert.equal(limitedActive.status, "active");

  // Khi usage_limit = 10: used_count = 10 -> out_of_quota
  const limitedFull = resolvePromotionStatus(
    { status: "active", usage_limit: 10, startDate: "01/01/2026", expiry: future },
    10,
    now
  );
  assert.equal(limitedFull.status, "out_of_quota");
});
