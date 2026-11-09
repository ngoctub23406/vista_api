const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

// Explicitly load .env.test only
dotenv.config({ path: "D:/VISTA/vista_api/.env.test" });

const authMiddleware = require("../middleware/auth.middleware");
const dashboardController = require("../controllers/admin/dashboard.controller");
const dashboardService = require("../services/dashboard.service");

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

test("1. Phân quyền Dashboard: Chỉ Manager được phép truy cập", () => {
  const managerOnly = authMiddleware.requireRole("Manager");

  let nextCalled = false;
  const next = () => {
    nextCalled = true;
  };

  // Manager: hợp lệ
  nextCalled = false;
  let res = mockResponse();
  managerOnly({ user: { Role: "Manager", User_id: "USR_001" } }, res, next);
  assert.equal(nextCalled, true, "Manager phải được phép truy cập Dashboard");

  // Staff: từ chối 403 Forbidden
  nextCalled = false;
  res = mockResponse();
  managerOnly({ user: { Role: "Staff", User_id: "USR_002" } }, res, next);
  assert.equal(nextCalled, false, "Staff không được phép truy cập Dashboard");
  assert.equal(res.statusCode, 403, "Staff phải nhận mã lỗi 403 Forbidden");

  // Customer: từ chối 403 Forbidden
  nextCalled = false;
  res = mockResponse();
  managerOnly({ user: { Role: "Customer", User_id: "CUST_001" } }, res, next);
  assert.equal(nextCalled, false, "Customer không được phép truy cập Dashboard");
  assert.equal(res.statusCode, 403);
});

test("2. Dashboard Service: Phân tích khoảng thời gian chuẩn xác", () => {
  const res30 = dashboardService.parsePeriod("30days");
  assert.equal(res30.period, "30days");
  assert.equal(res30.step, "day");
  const duration30 = res30.current.end - res30.current.start;
  const prevDuration30 = res30.previous.end - res30.previous.start;
  assert.equal(Math.round(duration30 / (1000 * 3600 * 24)), 30, "Khoảng hiện tại phải là 30 ngày");
  assert.equal(Math.round(prevDuration30 / (1000 * 3600 * 24)), 30, "Khoảng kỳ trước phải có cùng độ dài");

  const res12m = dashboardService.parsePeriod("12months");
  assert.equal(res12m.step, "month", "12 tháng phải gom theo step month");

  const resCustom = dashboardService.parsePeriod("custom", "2026-01-01", "2026-01-10");
  assert.equal(resCustom.period, "custom");
  assert.equal(resCustom.step, "day");
});

test("3. Dashboard Controller: Trả về đầy đủ dữ liệu thực tế từ vista_test", async (t) => {
  await mongoose.connect(process.env.MONGODB_URI);
  assert.equal(mongoose.connection.name, "vista_test", "Bắt buộc kết nối vista_test");

  // 3.1. getSummaryCards
  await t.test("getSummaryCards 30days trả về 4 thẻ KPI hợp lệ", async () => {
    const req = { query: { period: "30days" }, user: { Role: "Manager" } };
    const res = mockResponse();
    await dashboardController.getSummaryCards(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.ok(data.netRevenue, "Có KPI netRevenue");
    assert.ok(data.completedOrders, "Có KPI completedOrders");
    assert.ok(data.aov, "Có KPI aov");
    assert.ok(data.deliverySuccessRate, "Có KPI deliverySuccessRate");
    assert.ok(data.netRevenue.tooltip, "netRevenue có tooltip giải thích");
    assert.ok(data.aov.tooltip, "aov có tooltip giải thích");
    assert.ok(data.deliverySuccessRate.tooltip, "deliverySuccessRate có tooltip");
  });

  // 3.2. getRevenueTrend
  await t.test("getRevenueTrend 30days trả về chuỗi điểm không fake data", async () => {
    const req = { query: { period: "30days" }, user: { Role: "Manager" } };
    const res = mockResponse();
    await dashboardController.getRevenueTrend(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.ok(Array.isArray(data.points), "points là mảng");
    assert.ok(data.points.length >= 30, "Khoảng 30 ngày phải có ít nhất 30 điểm");
    data.points.forEach((pt) => {
      assert.ok(pt.label, "Mỗi điểm có label");
      assert.equal(typeof pt.netRevenue, "number", "netRevenue là số thực tế");
      assert.equal(typeof pt.prevNetRevenue, "number", "prevNetRevenue là số");
    });
  });

  // 3.3. getOrderPipeline
  await t.test("getOrderPipeline phân loại đầy đủ các trạng thái nghiệp vụ", async () => {
    const req = { query: { period: "12months" }, user: { Role: "Manager" } };
    const res = mockResponse();
    await dashboardController.getOrderPipeline(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.equal(data.total, 120, "12 tháng có 120 đơn");
    assert.ok(Array.isArray(data.pipeline), "pipeline là mảng");

    const keys = data.pipeline.map((p) => p.key);
    assert.ok(keys.includes("pending_confirmation"), "Có chờ xác nhận");
    assert.ok(keys.includes("processing"), "Có đang xử lý");
    assert.ok(keys.includes("shipping"), "Có đang giao");
    assert.ok(keys.includes("delivered"), "Có đã giao");
    assert.ok(keys.includes("review"), "Có đã đánh giá");
    assert.ok(keys.includes("returning"), "Có đang đổi trả");
    assert.ok(keys.includes("cancelled"), "Có đã hủy");
  });

  // 3.4. getPaymentBreakdown
  await t.test("getPaymentBreakdown phân tích theo trạng thái và phương thức", async () => {
    const req = { query: { period: "12months" }, user: { Role: "Manager" } };
    const res = mockResponse();
    await dashboardController.getPaymentBreakdown(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.equal(data.totalPayments, 120);

    const methods = data.byMethod.map((m) => m.method);
    assert.ok(methods.includes("COD"));
    assert.ok(methods.includes("VNPay"));
    assert.ok(methods.includes("MoMo"));
    assert.ok(methods.includes("BankTransfer"));
  });

  // 3.5. getCarrierPerformance
  await t.test("getCarrierPerformance thống kê đúng các đối tác vận chuyển", async () => {
    const req = { query: { period: "12months" }, user: { Role: "Manager" } };
    const res = mockResponse();
    await dashboardController.getCarrierPerformance(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const data = res.body.data;
    assert.equal(data.totalDeliveries, 120);

    const partners = data.partners.map((p) => p.partner);
    assert.ok(partners.includes("Viettel Post"));
    assert.ok(partners.includes("Giao Hàng Nhanh"));
  });

  // 3.6. getOperationalAlerts
  await t.test("getOperationalAlerts phát hiện các đơn quá hạn SLA và đổi trả", async () => {
    const req = { query: {}, user: { Role: "Manager" } };
    const res = mockResponse();
    await dashboardController.getOperationalAlerts(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    const alerts = res.body.data;
    assert.ok(Array.isArray(alerts));
    assert.ok(alerts.length > 0, "Phải có cảnh báo vận hành thực tế");

    const alertIds = alerts.map((a) => a.id);
    assert.ok(alertIds.includes("sla_overdue_orders"), "Phải có cảnh báo đơn quá hạn SLA");
    assert.ok(alertIds.includes("pending_returns"), "Phải có cảnh báo yêu cầu đổi trả chờ duyệt");
    assert.ok(alertIds.includes("pending_bank_orders"), "Phải có cảnh báo đơn chuyển khoản chờ");

    // Kiểm tra link điều hướng
    alerts.forEach((alert) => {
      assert.ok(alert.link, `Cảnh báo ${alert.id} phải có link điều hướng`);
      assert.ok(alert.count > 0, `Cảnh báo ${alert.id} phải có số lượng đối tượng`);
    });
  });

  // 3.7. KIỂM THỬ DEF-01: DOANH THU, HOÀN TIỀN, COMPLETED ORDERS VÀ AOV
  await t.test("DEF-01: Doanh thu thuần, hoàn tiền thực tế và tập đơn hoàn thành", async () => {
    const req = { query: { period: "12months" }, user: { Role: "Manager" } };
    const res = mockResponse();
    await dashboardController.getSummaryCards(req, res);

    assert.equal(res.statusCode, 200);
    const data = res.body.data;

    // 12 tháng: toàn bộ 89 đơn đủ điều kiện (85 delivered/review + 4 returning đã hoàn tất/từ chối)
    assert.equal(data.completedOrders.value, 89, "Số đơn hoàn tất 12 tháng phải là 89");
    assert.equal(data.netRevenue.value, 3033075000, "Doanh thu thuần phải trừ đúng 10.125.000 hoàn tiền (3.033.075.000 ₫)");
    assert.equal(data.aov.value, 34079494, "AOV = 3.033.075.000 / 89 = 34.079.494 ₫");

    // Kiểm tra mẫu số AOV và tử số Net Revenue cùng tập đơn
    assert.equal(Math.round(data.netRevenue.value / data.completedOrders.value), data.aov.value);
  });

  // 3.8. KIỂM THỬ DEF-02: DELIVERY SUCCESS RATE THEO KỲ
  await t.test("DEF-02: Tỷ lệ giao hàng thành công không bị leak đơn thất bại lịch sử", async () => {
    // Kỳ 7 ngày: Trong 7 ngày qua có 18 đơn giao thành công, 0 đơn thất bại
    const req7d = { query: { period: "7days" }, user: { Role: "Manager" } };
    const res7d = mockResponse();
    await dashboardController.getSummaryCards(req7d, res7d);

    const data7d = res7d.body.data.deliverySuccessRate;
    assert.equal(data7d.deliveredCount, 18, "7 ngày qua có 18 đơn giao thành công");
    assert.equal(data7d.failedCount, 0, "7 ngày qua không có đơn giao thất bại (không bị leak lịch sử)");
    assert.equal(data7d.value, 100, "Tỷ lệ giao hàng 7 ngày qua phải đạt 100%");

    // Kỳ 12 tháng: Bao gồm cả 7 đơn thất bại trong lịch sử
    const req12m = { query: { period: "12months" }, user: { Role: "Manager" } };
    const res12m = mockResponse();
    await dashboardController.getSummaryCards(req12m, res12m);

    const data12m = res12m.body.data.deliverySuccessRate;
    assert.equal(data12m.failedCount, 7, "12 tháng có 7 đơn vận chuyển thất bại");
    assert.ok(data12m.value > 90 && data12m.value < 100, "Tỷ lệ 12 tháng phản ánh đúng thất bại lịch sử");
  });

  // 3.9. KIỂM THỬ DEF-03: TIMEZONE & ĐỐI SOÁT DOANH THU TREND
  await t.test("DEF-03: Biểu đồ doanh thu xu hướng không mất tháng và đối soát 100% với Summary", async () => {
    const req12m = { query: { period: "12months" }, user: { Role: "Manager" } };
    const resSummary = mockResponse();
    const resTrend = mockResponse();

    await dashboardController.getSummaryCards(req12m, resSummary);
    await dashboardController.getRevenueTrend(req12m, resTrend);

    const summaryNet = resSummary.body.data.netRevenue.value;
    const trendData = resTrend.body.data;

    // Kiểm tra không mất tháng đầu (2025-11) và tháng cuối (2026-11)
    const keys = trendData.points.map((p) => p.key);
    assert.ok(keys.includes("2025-11"), "Phải có tháng đầu 2025-11");
    assert.ok(keys.includes("2026-11"), "Phải có tháng cuối 2026-11");

    // Tháng 11/2026 phải có doanh thu đầy đủ của 9 đơn
    const nov2026Point = trendData.points.find((p) => p.key === "2026-11");
    assert.ok(nov2026Point && nov2026Point.netRevenue === 332840000, "Tháng 11/2026 phải đạt 332.840.000 ₫");

    // Tổng các bucket phải bằng đúng Net Revenue của Summary Card
    assert.equal(trendData.totalNetRevenue, summaryNet, "Tổng doanh thu biểu đồ phải khớp 100% với Summary Net Revenue");
  });

  // 3.10. KIỂM THỬ DEF-04: PAYMENT SUCCESS RATE & COD SEGREGATION
  await t.test("DEF-04: Phân tách rõ ràng tỷ lệ thanh toán online và COD order flow", async () => {
    const req = { query: { period: "12months" }, user: { Role: "Manager" } };
    const res = mockResponse();
    await dashboardController.getPaymentBreakdown(req, res);

    assert.equal(res.statusCode, 200);
    const data = res.body.data;

    assert.ok(data.onlineFlow, "Có phân tích onlineFlow");
    assert.ok(data.codFlow, "Có phân tích codFlow");

    // Online: 57 paid, 3 failed -> successRate = 57 / 60 = 95.0%
    assert.equal(data.onlineFlow.paid, 57);
    assert.equal(data.onlineFlow.failed, 3);
    assert.equal(data.onlineFlow.pending, 4, "BankTransfer pending không bị coi là thất bại");
    assert.equal(data.onlineFlow.successRate, 95.0);

    // COD: 44 paid, 8 pending, 3 failed -> successRate = 44 / 47 = 93.6%
    assert.equal(data.codFlow.paid, 44);
    assert.equal(data.codFlow.pending, 8, "8 đơn COD đang xử lý kho không bị coi là thất bại");
    assert.equal(data.codFlow.failed, 3);
    assert.equal(data.codFlow.successRate, 93.6);

    // Overall success rate trên các đơn đã chốt kết quả (101 / 107 = 94.4%)
    assert.equal(data.overallSuccessRate, 94.4);
  });

  // 3.11. KIỂM THỬ DEF-ACCEPT-01: CUSTOM PERIOD TIMEZONE BOUNDARY (8 KỊCH BẢN BẮT BUỘC)
  await t.test("DEF-ACCEPT-01: Ranh giới ngày múi giờ UTC+7 trong khoảng tùy chỉnh", async (st) => {
    // 1 & 2: 01/06/2026 đến 30/06/2026 đúng 30 điểm và KHÔNG có 01/07/2026
    await st.test("1 & 2. 01/06/2026 - 30/06/2026 có đúng 30 điểm và không xuất hiện 01/07", async () => {
      const req = { query: { period: "custom", from: "2026-06-01", to: "2026-06-30" }, user: { Role: "Manager" } };
      const resTrend = mockResponse();
      const resSummary = mockResponse();

      await dashboardController.getRevenueTrend(req, resTrend);
      await dashboardController.getSummaryCards(req, resSummary);

      const trend = resTrend.body.data;
      const summary = resSummary.body.data;

      assert.equal(trend.points.length, 30, "Tháng 6/2026 phải có đúng 30 điểm dữ liệu");
      assert.equal(trend.points[0].key, "2026-06-01", "Điểm đầu tiên là 01/06");
      assert.equal(trend.points[29].key, "2026-06-30", "Điểm cuối cùng là 30/06");

      const hasJuly1 = trend.points.some((p) => p.key === "2026-07-01");
      assert.equal(hasJuly1, false, "Tuyệt đối không xuất hiện ngày 01/07/2026");

      // 6. Tổng Revenue Trend vẫn khớp Summary
      assert.equal(trend.totalNetRevenue, summary.netRevenue.value, "Tổng Trend phải khớp 100% với Summary Card");
      assert.equal(trend.totalNetRevenue, 587275000, "Doanh thu tháng 6/2026 là 587.275.000 ₫");
    });

    // 3. 01/11/2026 đến 30/11/2026: đúng 30 điểm
    await st.test("3. 01/11/2026 - 30/11/2026 có đúng 30 điểm", async () => {
      const req = { query: { period: "custom", from: "2026-11-01", to: "2026-11-30" }, user: { Role: "Manager" } };
      const res = mockResponse();
      await dashboardController.getRevenueTrend(req, res);

      const trend = res.body.data;
      assert.equal(trend.points.length, 30, "Tháng 11/2026 phải có đúng 30 điểm");
      assert.equal(trend.points[0].key, "2026-11-01");
      assert.equal(trend.points[29].key, "2026-11-30");
      assert.equal(trend.points.some((p) => p.key === "2026-12-01"), false, "Không có ngày 01/12");
    });

    // 4. Khoảng thời gian chỉ có đúng 1 ngày: đúng 1 điểm
    await st.test("4. Khoảng thời gian 1 ngày có đúng 1 điểm", async () => {
      const req = { query: { period: "custom", from: "2026-06-15", to: "2026-06-15" }, user: { Role: "Manager" } };
      const res = mockResponse();
      await dashboardController.getRevenueTrend(req, res);

      const trend = res.body.data;
      assert.equal(trend.points.length, 1, "Khoảng 1 ngày phải có đúng 1 điểm");
      assert.equal(trend.points[0].key, "2026-06-15");
      assert.equal(trend.points[0].label, "15/06");
    });

    // 5. Đi qua ranh giới năm: không lệch ngày/tháng
    await st.test("5. Khoảng thời gian đi qua ranh giới năm (28/12/2025 - 03/01/2026) đúng 7 điểm", async () => {
      const req = { query: { period: "custom", from: "2025-12-28", to: "2026-01-03" }, user: { Role: "Manager" } };
      const res = mockResponse();
      await dashboardController.getRevenueTrend(req, res);

      const trend = res.body.data;
      assert.equal(trend.points.length, 7, "28/12 đến 03/01 có đúng 7 ngày");
      assert.equal(trend.points[0].key, "2025-12-28");
      assert.equal(trend.points[3].key, "2025-12-31");
      assert.equal(trend.points[4].key, "2026-01-01");
      assert.equal(trend.points[6].key, "2026-01-03");
    });

    // 7. Không ảnh hưởng các bộ lọc chuẩn 7d, 30d, 90d, 12m
    await st.test("7. Các bộ lọc chuẩn 7d, 30d, 90d, 12m vẫn hoạt động hoàn hảo", async () => {
      const r7 = dashboardService.parsePeriod("7days");
      const r30 = dashboardService.parsePeriod("30days");
      const r90 = dashboardService.parsePeriod("90days");
      const r12m = dashboardService.parsePeriod("12months");

      assert.equal(r7.step, "day");
      assert.equal(r30.step, "day");
      assert.equal(r90.step, "day");
      assert.equal(r12m.step, "month");
    });

    // 8. Khoảng thời gian không có doanh thu
    await st.test("8. Khoảng thời gian không có đơn hoàn tất hiển thị netRevenue = 0", async () => {
      const req = { query: { period: "custom", from: "2026-08-06", to: "2026-08-08" }, user: { Role: "Manager" } };
      const resSummary = mockResponse();
      const resTrend = mockResponse();

      await dashboardController.getSummaryCards(req, resSummary);
      await dashboardController.getRevenueTrend(req, resTrend);

      const summary = resSummary.body.data;
      const trend = resTrend.body.data;

      assert.equal(summary.netRevenue.value, 0, "Doanh thu kỳ không có đơn phải là 0 ₫");
      assert.equal(trend.totalNetRevenue, 0, "Biểu đồ xu hướng tổng doanh thu = 0 ₫");
      assert.equal(trend.points.length, 3, "Đúng 3 ngày từ 06/08 đến 08/08");
      trend.points.forEach((p) => {
        assert.equal(p.netRevenue, 0, `Ngày ${p.key} phải hiển thị mức 0 ₫`);
      });
    });
  });

  await mongoose.disconnect();
});
