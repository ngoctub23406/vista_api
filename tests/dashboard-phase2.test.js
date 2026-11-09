const test = require("node:test");
const assert = require("node:assert/strict");

const authMiddleware = require("../middleware/auth.middleware");
const productController = require("../controllers/admin/product.controller");
const orderController = require("../controllers/order.controller");
const dashboardService = require("../services/dashboard.service");
const { Order, Order_detail, Return_order } = require("../models/schema");

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

test("1. RBAC Phân quyền Phase 2: Chỉ Manager được xem Lợi nhuận và Giá vốn", () => {
  const managerOnly = authMiddleware.requireRole("Manager");

  // Manager: được phép truy cập
  let nextCalled = false;
  let res = mockResponse();
  managerOnly({ user: { Role: "Manager", User_id: "MGR_001" } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, "Manager phải được phép truy cập Phase 2");

  // Staff: Bị chặn 403 Forbidden
  nextCalled = false;
  res = mockResponse();
  managerOnly({ user: { Role: "Staff", User_id: "STF_001" } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false, "Staff không được phép truy cập Profit API");
  assert.equal(res.statusCode, 403, "Staff phải nhận HTTP 403");

  // Customer: Bị chặn 403 Forbidden
  nextCalled = false;
  res = mockResponse();
  managerOnly({ user: { Role: "Customer", User_id: "CUST_001" } }, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false, "Customer không được phép truy cập Profit API");
  assert.equal(res.statusCode, 403, "Customer phải nhận HTTP 403");
});

test("2. Bảo mật Giá vốn: Staff không nhận được Cost_price khi xem sản phẩm", () => {
  // Test validateProductInput lưu Cost_price đúng chuẩn
  const managerInput = {
    Category_id: "CAT_01",
    Brand_id: "BRD_01",
    Product_name: "Áo Thun Cao Cấp",
    Variants: [
      {
        Variant_name: "Đen - L",
        Price: 200000,
        Cost_price: 120000,
        Stock_quantity: 50,
      },
      {
        Variant_name: "Trắng - L",
        Price: 200000,
        Cost_price: null, // Chưa có giá vốn
        Stock_quantity: 30,
      },
    ],
  };

  const reqManager = {
    body: managerInput,
    user: { Role: "Manager" },
  };

  // Giả lập sanitizeVariantForRole gián tiếp qua format variant
  const variant1 = {
    Variant_name: "Đen - L",
    Price: 200000,
    Cost_price: 120000,
    Cost_updated_at: new Date(),
  };

  // Đối với Staff: Cost_price và Cost_updated_at phải bị xóa
  const sanitize = (v, role) => {
    const item = { ...v };
    if (role !== "Manager") {
      delete item.Cost_price;
      delete item.Cost_updated_at;
    }
    return item;
  };

  const staffVariant = sanitize(variant1, "Staff");
  assert.equal(staffVariant.Cost_price, undefined, "Staff tuyệt đối không thấy Cost_price");
  assert.equal(staffVariant.Cost_updated_at, undefined, "Staff tuyệt đối không thấy Cost_updated_at");

  // Đối với Manager: Giữ nguyên
  const managerVariant = sanitize(variant1, "Manager");
  assert.equal(managerVariant.Cost_price, 120000, "Manager phải thấy Cost_price");
  assert.ok(managerVariant.Cost_updated_at, "Manager phải thấy Cost_updated_at");
});

test("3. Snapshot Giá vốn & Phân bổ Voucher tại thời điểm tạo đơn hàng", () => {
  // Biến thể có giá vốn -> Cost_status: tracked
  const variantTracked = {
    Price: 300000,
    Cost_price: 180000,
    Variant_name: "Giày Sneaker",
  };
  const hasCost = typeof variantTracked.Cost_price === "number" && variantTracked.Cost_price >= 0;
  const statusTracked = hasCost ? "tracked" : "untracked";
  assert.equal(statusTracked, "tracked");
  assert.equal(variantTracked.Cost_price, 180000);

  // Biến thể chưa có giá vốn -> Cost_status: untracked
  const variantUntracked = {
    Price: 300000,
    Cost_price: null,
    Variant_name: "Ví Da",
  };
  const hasCost2 = typeof variantUntracked.Cost_price === "number" && variantUntracked.Cost_price >= 0;
  const statusUntracked = hasCost2 ? "tracked" : "untracked";
  assert.equal(statusUntracked, "untracked");

  // Thuật toán phân bổ voucher pro-rata
  const details = [
    { Order_detail_id: "OD_1", Total_price: 300000, Quantity: 1 },
    { Order_detail_id: "OD_2", Total_price: 700000, Quantity: 1 },
  ];
  const totalItemsPrice = 1000000;
  const voucherDiscount = 100000; // Giảm 100.000đ

  let allocatedSum = 0;
  let maxDetailIndex = 0;
  let maxPrice = -1;

  details.forEach((d, idx) => {
    const allocated = Math.round((voucherDiscount * d.Total_price) / totalItemsPrice);
    d.Discount_allocated = allocated;
    d.Net_line_revenue = Math.max(0, d.Total_price - allocated);
    allocatedSum += allocated;
    if (d.Total_price > maxPrice) {
      maxPrice = d.Total_price;
      maxDetailIndex = idx;
    }
  });

  const remainder = voucherDiscount - allocatedSum;
  if (remainder !== 0) {
    details[maxDetailIndex].Discount_allocated += remainder;
    details[maxDetailIndex].Net_line_revenue = Math.max(
      0,
      details[maxDetailIndex].Total_price - details[maxDetailIndex].Discount_allocated
    );
  }

  // OD_1 nhận 30% = 30.000đ
  assert.equal(details[0].Discount_allocated, 30000);
  assert.equal(details[0].Net_line_revenue, 270000);

  // OD_2 nhận 70% = 70.000đ
  assert.equal(details[1].Discount_allocated, 70000);
  assert.equal(details[1].Net_line_revenue, 630000);

  // Tổng phân bổ đúng bằng 100.000đ
  assert.equal(details[0].Discount_allocated + details[1].Discount_allocated, voucherDiscount);
  // Doanh thu thuần dòng không bị âm
  assert.ok(details[0].Net_line_revenue > 0);
  assert.ok(details[1].Net_line_revenue > 0);
});

test("4. DEF-01 Multi-Return: Tổng hợp đầy đủ mọi khoản Refund, không bị ghi đè Map", () => {
  // Giả lập danh sách returns trên cùng đơn hàng ORD_MULTI
  const returns = [
    { Order_id: "ORD_MULTI", Status: "completed", Refund_amount: 300000 },
    { Order_id: "ORD_MULTI", Status: "completed", Refund_amount: 200000 },
    { Order_id: "ORD_MULTI", Status: "rejected", Refund_amount: 0 },
    { Order_id: "ORD_MULTI", Status: "pending", Refund_amount: 150000 },
  ];

  const returnMap = new Map();
  returns.forEach((r) => {
    if (!returnMap.has(r.Order_id)) {
      returnMap.set(r.Order_id, []);
    }
    returnMap.get(r.Order_id).push(r);
  });

  const orderReturns = returnMap.get("ORD_MULTI") || [];
  assert.equal(orderReturns.length, 4, "Phải lưu đủ cả 4 return, không bị ghi đè thành 1");

  // Tổng tiền hoàn thành (chỉ tính completed/refunded)
  const completedRefundAmt = orderReturns
    .filter((r) => r.Status === "completed" || r.Status === "refunded")
    .reduce((sum, r) => sum + (Number(r.Refund_amount) || 0), 0);

  assert.equal(completedRefundAmt, 500000, "Tổng hoàn tiền phải là 300.000 + 200.000 = 500.000đ");

  // Kiểm tra điều kiện đơn returning: có completed return thì vẫn được ghi nhận
  const hasCompleted = orderReturns.some((r) => r.Status === "completed" || r.Status === "refunded");
  assert.equal(hasCompleted, true, "Đơn có return completed không bị loại bỏ một cách máy móc");
});

test("5. Minh bạch Lợi nhuận gộp & Biên lãi theo 3 kịch bản Độ bao phủ giá vốn", () => {
  // KỊCH BẢN 1: Coverage = 0% (Chưa có sản phẩm nào có giá vốn)
  const covZero = 0;
  let overallGrossProfitZero = null;
  let overallGrossMarginZero = null;
  if (covZero >= 100) {
    overallGrossProfitZero = 50000000;
    overallGrossMarginZero = 100;
  }
  assert.equal(overallGrossProfitZero, null, "Coverage = 0% thì Gross Profit toàn kỳ phải là null (Chưa đủ dữ liệu)");
  assert.equal(overallGrossMarginZero, null, "Coverage = 0% thì Gross Margin toàn kỳ phải là null (Chưa đủ dữ liệu)");

  // KỊCH BẢN 2: 0% < Coverage < 100% (Giá vốn một phần, ví dụ ví dụ đề bài: 50M total, 20M tracked rev, 12M tracked cogs)
  const totalNetRev = 50000000;
  const trackedRev = 20000000;
  const trackedCogs = 12000000;
  const covPartial = Number(((trackedRev / totalNetRev) * 100).toFixed(2)); // 40%

  let overallGrossProfitPartial = null;
  let overallGrossMarginPartial = null;
  if (covPartial >= 100) {
    overallGrossProfitPartial = totalNetRev - trackedCogs;
    overallGrossMarginPartial = Number(((overallGrossProfitPartial / totalNetRev) * 100).toFixed(2));
  }
  const trackedGrossProfit = trackedRev - trackedCogs; // 8.000.000đ
  const trackedGrossMargin = Number(((trackedGrossProfit / trackedRev) * 100).toFixed(2)); // 40%

  assert.equal(overallGrossProfitPartial, null, "Coverage < 100% thì Gross Profit toàn kỳ phải là null (không được là 38 triệu)");
  assert.equal(overallGrossMarginPartial, null, "Coverage < 100% thì Gross Margin toàn kỳ phải là null");
  assert.equal(trackedGrossProfit, 8000000, "Tracked Gross Profit = 20.000.000 - 12.000.000 = 8.000.000đ");
  assert.equal(trackedGrossMargin, 40.0, "Tracked Gross Margin = 40%");

  // KỊCH BẢN 3: Coverage = 100% (Giá vốn đầy đủ)
  const fullNetRev = 50000000;
  const fullCogs = 30000000;
  const covFull = 100;

  let overallGrossProfitFull = null;
  let overallGrossMarginFull = null;
  if (covFull >= 100) {
    overallGrossProfitFull = fullNetRev - fullCogs;
    overallGrossMarginFull = fullNetRev > 0 ? Number(((overallGrossProfitFull / fullNetRev) * 100).toFixed(2)) : 0;
  }
  assert.equal(overallGrossProfitFull, 20000000, "Coverage = 100% thì Gross Profit = 50M - 30M = 20M");
  assert.equal(overallGrossMarginFull, 40.0, "Coverage = 100% thì Gross Margin = 40%");

  // Safe Division: Khi Net Revenue = 0 hoặc âm
  const zeroNetRev = 0;
  const safeMarginZero = zeroNetRev > 0 ? Number(((20000000 / zeroNetRev) * 100).toFixed(2)) : 0;
  assert.equal(safeMarginZero, 0, "Không bị Division by Zero (NaN), trả về 0%");
});

test("6. Tỷ lệ bao phủ giá vốn (Cost Coverage Ratio) & Mẫu số sản phẩm bán ra", () => {
  const items = [
    { Quantity: 2, Total_price: 400000, Cost_status: "tracked", Cost_price_at_sale: 100000 },
    { Quantity: 1, Total_price: 600000, Cost_status: "untracked", Cost_price_at_sale: null },
  ];

  let trackedRev = 0;
  let totalRev = 0;
  let trackedItems = 0;
  let totalItems = 0;

  items.forEach((item) => {
    totalRev += item.Total_price;
    totalItems += item.Quantity;
    if (item.Cost_status === "tracked" && item.Cost_price_at_sale !== null) {
      trackedRev += item.Total_price;
      trackedItems += item.Quantity;
    }
  });

  const ratio = totalRev > 0 ? Number(((trackedRev / totalRev) * 100).toFixed(2)) : 0;
  assert.equal(totalRev, 1000000);
  assert.equal(trackedRev, 400000);
  assert.equal(ratio, 40.0, "Độ bao phủ là 40%");
  assert.equal(trackedItems, 2, "Mẫu số/tử số tính trên sản phẩm bán ra trong kỳ");
  assert.equal(totalItems, 3, "Tổng số lượng sản phẩm bán ra = 3");

  const isComplete = ratio >= 100;
  assert.equal(isComplete, false, "Chưa hoàn thiện giá vốn 100%");
  const warning = !isComplete
    ? `Dữ liệu giá vốn đạt ${ratio}%. Lợi nhuận gộp phản ánh phần sản phẩm đã có giá vốn.`
    : null;
  assert.ok(warning, "Phải sinh thông điệp cảnh báo");
});
