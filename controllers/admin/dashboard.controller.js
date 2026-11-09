const dashboardService = require("../../services/dashboard.service");

/**
 * Helper parse params an toàn
 */
function getRangeFromQuery(req) {
  const period = req.query.period || "30days";
  const from = req.query.from;
  const to = req.query.to;
  return dashboardService.parsePeriod(period, from, to);
}

/**
 * GET /api/admin/dashboard/summary-cards
 * 4 Thẻ KPI đầu trang
 */
exports.getSummaryCards = async (req, res) => {
  try {
    const range = getRangeFromQuery(req);
    const data = await dashboardService.getSummaryCards(range);
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Dashboard getSummaryCards error:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy số liệu KPI tổng quan",
    });
  }
};

/**
 * GET /api/admin/dashboard/revenue-trend
 * Biểu đồ doanh thu theo thời gian
 */
exports.getRevenueTrend = async (req, res) => {
  try {
    const range = getRangeFromQuery(req);
    const data = await dashboardService.getRevenueTrend(range);
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Dashboard getRevenueTrend error:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy dữ liệu biểu đồ doanh thu",
    });
  }
};

/**
 * GET /api/admin/dashboard/order-pipeline
 * Phễu trạng thái đơn hàng
 */
exports.getOrderPipeline = async (req, res) => {
  try {
    const range = getRangeFromQuery(req);
    const data = await dashboardService.getOrderPipeline(range);
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Dashboard getOrderPipeline error:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy dữ liệu phễu đơn hàng",
    });
  }
};

/**
 * GET /api/admin/dashboard/payment-breakdown
 * Thống kê thanh toán
 */
exports.getPaymentBreakdown = async (req, res) => {
  try {
    const range = getRangeFromQuery(req);
    const data = await dashboardService.getPaymentBreakdown(range);
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Dashboard getPaymentBreakdown error:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy số liệu thanh toán",
    });
  }
};

/**
 * GET /api/admin/dashboard/carrier-performance
 * Thống kê hiệu quả giao hàng theo đối tác vận chuyển
 */
exports.getCarrierPerformance = async (req, res) => {
  try {
    const range = getRangeFromQuery(req);
    const data = await dashboardService.getCarrierPerformance(range);
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Dashboard getCarrierPerformance error:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy số liệu đơn vị vận chuyển",
    });
  }
};

/**
 * GET /api/admin/dashboard/operational-alerts
 * Danh sách cảnh báo vận hành khẩn cấp
 */
exports.getOperationalAlerts = async (req, res) => {
  try {
    const alerts = await dashboardService.getOperationalAlerts();
    return res.json({
      success: true,
      data: alerts,
    });
  } catch (error) {
    console.error("Dashboard getOperationalAlerts error:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy danh sách cảnh báo vận hành",
    });
  }
};

/**
 * GET /api/admin/dashboard/profit-summary
 * Tổng quan Giá vốn & Lợi nhuận (Phase 2)
 */
exports.getProfitSummary = async (req, res) => {
  try {
    const range = getRangeFromQuery(req);
    const data = await dashboardService.getProfitSummary(range);
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Dashboard getProfitSummary error:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy số liệu quản trị giá vốn và lợi nhuận",
    });
  }
};

/**
 * GET /api/admin/dashboard/profit-trend
 * Biểu đồ xu hướng Doanh thu vs Lợi nhuận gộp (Phase 2)
 */
exports.getProfitTrend = async (req, res) => {
  try {
    const range = getRangeFromQuery(req);
    const data = await dashboardService.getProfitTrend(range);
    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Dashboard getProfitTrend error:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể lấy dữ liệu biểu đồ lợi nhuận",
    });
  }
};
