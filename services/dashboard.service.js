const {
  Order,
  Order_detail,
  Payment,
  Delivery,
  Return_order,
  Category,
  Product,
  Product_variant,
} = require("../models/schema");
const { buildSlaStages } = require("./order-sla.service");
const { isOrderConfirmed, ORDER_EVENTS } = require("./order-status.service");

/**
 * Chuyển đổi Date sang các thành phần lịch Việt Nam (UTC+7)
 */
function toVietnamDateParts(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  const vnTime = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const year = vnTime.getUTCFullYear();
  const month = vnTime.getUTCMonth() + 1;
  const day = vnTime.getUTCDate();
  return {
    year,
    month,
    day,
    yearMonth: `${year}-${String(month).padStart(2, "0")}`,
    yearMonthDay: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/**
 * Phân tích khoảng thời gian cho Dashboard (Hiện tại và Kỳ trước)
 * @param {string} period '7days' | '30days' | '90days' | '12months' | 'custom'
 * @param {string} from YYYY-MM-DD
 * @param {string} to YYYY-MM-DD
 */
function parsePeriod(period = "30days", from, to) {
  const now = new Date();
  let currentStart;
  let currentEnd = new Date(now);
  let step = "day"; // 'day' | 'month'

  if (period === "custom" && from && to) {
    // DEF-ACCEPT-01: Định dạng theo múi giờ kinh doanh Việt Nam (UTC+7) để tránh lệch ngày/tháng ranh giới
    const fromStr = from.includes("T") ? from : `${from}T00:00:00.000+07:00`;
    const toStr = to.includes("T") ? to : `${to}T23:59:59.999+07:00`;
    currentStart = new Date(fromStr);
    currentEnd = new Date(toStr);
    const diffDays = Math.ceil((currentEnd - currentStart) / (1000 * 60 * 60 * 24));
    if (diffDays > 60) step = "month";
    else step = "day";
  } else if (period === "7days") {
    currentStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    step = "day";
  } else if (period === "90days") {
    currentStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    step = "day";
  } else if (period === "12months") {
    currentStart = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    step = "month";
  } else {
    // Mặc định 30days
    currentStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    step = "day";
  }

  const durationMs = currentEnd.getTime() - currentStart.getTime();
  const previousEnd = new Date(currentStart.getTime() - 1);
  const previousStart = new Date(previousEnd.getTime() - durationMs);

  return {
    period,
    step,
    current: { start: currentStart, end: currentEnd },
    previous: { start: previousStart, end: previousEnd },
  };
}

/**
 * Helper lấy tập đơn hàng đủ điều kiện ghi nhận doanh thu và đơn hoàn tất (DEF-01):
 * 1. Đơn có Status in ['delivered', 'review'].
 * 2. Đơn có Status == 'returning' nhưng quy trình đổi trả đã chốt kết quả:
 *    - 'completed' / 'refunded': đã hoàn tất đổi trả một phần/toàn phần -> ghi nhận doanh thu sau khi trừ tiền hoàn thực tế.
 *    - 'rejected': bị từ chối đổi trả -> khách giữ hàng, ghi nhận 100% doanh thu đơn hàng.
 * Đơn 'returning' đang ở trạng thái 'pending' hoặc 'received' (chưa duyệt / đang kiểm định kho) chưa hoàn tất nên KHÔNG tính vào completed orders và không ghi nhận hoàn tiền.
 */
async function getEligibleOrdersWithReturns(startDate, endDate) {
  const matchFilter = {
    Created_at: { $gte: startDate, $lte: endDate },
    Status: { $in: ["delivered", "review", "returning"] },
  };

  const orders = await Order.find(matchFilter)
    .select("Order_id Total_amount Total_items_price Voucher_discount_amount Status Created_at")
    .lean();

  if (orders.length === 0) {
    return {
      eligibleOrders: [],
      orderCount: 0,
      grossAmount: 0,
      totalRefund: 0,
      netRevenue: 0,
      aov: 0,
      refundMap: new Map(),
    };
  }

  const orderIds = orders.map((o) => o.Order_id);
  const returns = await Return_order.find({
    Order_id: { $in: orderIds },
  })
    .select("Order_id Status Refund_amount")
    .lean();

  const returnMap = new Map();
  returns.forEach((r) => {
    if (!returnMap.has(r.Order_id)) {
      returnMap.set(r.Order_id, []);
    }
    returnMap.get(r.Order_id).push(r);
  });

  const eligibleOrders = [];
  const refundMap = new Map();
  let grossAmount = 0;
  let totalRefund = 0;

  for (const order of orders) {
    const orderReturns = returnMap.get(order.Order_id) || [];
    const orderTotal = Number(order.Total_amount) || 0;

    const completedRefundAmt = orderReturns
      .filter((r) => r.Status === "completed" || r.Status === "refunded")
      .reduce((sum, r) => sum + (Number(r.Refund_amount) || 0), 0);

    if (order.Status === "delivered" || order.Status === "review") {
      eligibleOrders.push(order);
      grossAmount += orderTotal;
      if (completedRefundAmt > 0) {
        totalRefund += completedRefundAmt;
        refundMap.set(order.Order_id, completedRefundAmt);
      }
    } else if (order.Status === "returning") {
      const hasCompleted = orderReturns.some((r) => r.Status === "completed" || r.Status === "refunded");
      const allResolved = orderReturns.length > 0 && orderReturns.every((r) => ["completed", "refunded", "rejected"].includes(r.Status));

      if (hasCompleted || allResolved) {
        eligibleOrders.push(order);
        grossAmount += orderTotal;
        if (completedRefundAmt > 0) {
          totalRefund += completedRefundAmt;
          refundMap.set(order.Order_id, completedRefundAmt);
        }
      }
    }
  }

  const orderCount = eligibleOrders.length;
  const netRevenue = Math.max(0, grossAmount - totalRefund);
  const aov = orderCount > 0 ? Math.round(netRevenue / orderCount) : 0;

  return {
    eligibleOrders,
    orderCount,
    grossAmount,
    totalRefund,
    netRevenue,
    aov,
    refundMap,
  };
}

/**
 * Tính toán số liệu doanh thu thuần và đơn hoàn thành trong một khoảng thời gian
 */
async function calculateNetMetrics(startDate, endDate) {
  const result = await getEligibleOrdersWithReturns(startDate, endDate);
  return {
    orderCount: result.orderCount,
    grossAmount: result.grossAmount,
    totalRefund: result.totalRefund,
    netRevenue: result.netRevenue,
    aov: result.aov,
  };
}

/**
 * Tính tỷ lệ giao hàng thành công (DEF-02):
 * Cả Delivered và Failed đều phải nằm trong khoảng thời gian [startDate, endDate].
 * - Delivered: căn cứ theo Delivered_at.
 * - Failed: do Delivery Schema không có Updated_at/Failed_at, thời điểm thất bại/hủy
 *   được xác định qua Cancelled_at của Order (hoặc Created_at nếu Cancelled_at null).
 */
async function calculateDeliverySuccess(startDate, endDate) {
  const deliveredDeliveries = await Delivery.find({
    Status: "delivered",
    Delivered_at: { $gte: startDate, $lte: endDate },
  })
    .select("Delivery_id Order_id Shipping_partner Status Delivered_at")
    .lean();

  const cancelledOrders = await Order.find({
    Status: "cancelled",
    $or: [
      { Cancelled_at: { $gte: startDate, $lte: endDate } },
      { Cancelled_at: null, Created_at: { $gte: startDate, $lte: endDate } },
    ],
  })
    .select("Order_id")
    .lean();

  const cancelledOrderIds = cancelledOrders.map((o) => o.Order_id);
  const failedDeliveries = cancelledOrderIds.length > 0
    ? await Delivery.find({
        Status: "failed",
        Order_id: { $in: cancelledOrderIds },
      })
        .select("Delivery_id Order_id Shipping_partner Status")
        .lean()
    : [];

  const deliveredCount = deliveredDeliveries.length;
  const failedCount = failedDeliveries.length;
  const totalCompletedDelivery = deliveredCount + failedCount;

  const rate = totalCompletedDelivery > 0
    ? Number(((deliveredCount / totalCompletedDelivery) * 100).toFixed(2))
    : 0;

  return {
    deliveredCount,
    failedCount,
    rate,
    totalCompletedDelivery,
  };
}

/**
 * Tính % tăng trưởng và chênh lệch
 */
function calculateDelta(currentVal, prevVal) {
  if (
    currentVal === null ||
    currentVal === undefined ||
    prevVal === null ||
    prevVal === undefined
  ) {
    return {
      diff: null,
      percent: null,
      hasComparison: false,
    };
  }

  const diff = currentVal - prevVal;
  let percent = null;

  if (prevVal > 0) {
    percent = Number(((diff / prevVal) * 100).toFixed(2));
  }

  return {
    diff,
    percent,
    hasComparison: prevVal > 0,
  };
}

/**
 * 1. Tổng hợp 4 KPI Cards đầu trang
 */
async function getSummaryCards(range) {
  const current = await calculateNetMetrics(range.current.start, range.current.end);
  const previous = await calculateNetMetrics(range.previous.start, range.previous.end);

  const currentDelivery = await calculateDeliverySuccess(range.current.start, range.current.end);
  const previousDelivery = await calculateDeliverySuccess(range.previous.start, range.previous.end);

  return {
    netRevenue: {
      value: current.netRevenue,
      prevValue: previous.netRevenue,
      ...calculateDelta(current.netRevenue, previous.netRevenue),
      tooltip: "Doanh thu thuần từ các đơn đã giao thành công và đơn đổi trả đã chốt kết quả, trừ tiền hoàn trả thực tế.",
    },
    completedOrders: {
      value: current.orderCount,
      prevValue: previous.orderCount,
      ...calculateDelta(current.orderCount, previous.orderCount),
      tooltip: "Số đơn hàng hoàn thành (đã giao thành công hoặc đổi trả đã chốt kết quả) trong kỳ.",
    },
    aov: {
      value: current.aov,
      prevValue: previous.aov,
      ...calculateDelta(current.aov, previous.aov),
      tooltip: "Giá trị đơn hàng trung bình = Doanh thu thuần chia cho Số đơn hoàn tất.",
    },
    deliverySuccessRate: {
      value: currentDelivery.rate,
      prevValue: previousDelivery.rate,
      deliveredCount: currentDelivery.deliveredCount,
      failedCount: currentDelivery.failedCount,
      ...calculateDelta(currentDelivery.rate, previousDelivery.rate),
      tooltip: "Tỷ lệ đơn giao thành công trên tổng số đơn hoàn tất phát hàng (thành công + thất bại) trong kỳ.",
    },
    periodInfo: {
      currentStart: range.current.start,
      currentEnd: range.current.end,
      previousStart: range.previous.start,
      previousEnd: range.previous.end,
    },
  };
}

/**
 * 2. Biểu đồ doanh thu theo chuỗi thời gian (thực tế, không fake data) (DEF-01, DEF-03)
 */
async function getRevenueTrend(range) {
  const { current, previous, step } = range;

  // Lấy tập đơn hàng đủ điều kiện cho kỳ hiện tại và kỳ trước
  const currentData = await getEligibleOrdersWithReturns(current.start, current.end);
  const previousData = await getEligibleOrdersWithReturns(previous.start, previous.end);

  const points = [];

  const startVN = toVietnamDateParts(current.start);
  const endVN = toVietnamDateParts(current.end);
  const startPrevVN = toVietnamDateParts(previous.start);
  const endPrevVN = toVietnamDateParts(previous.end);

  if (step === "month") {
    // Gom theo từng tháng (cho 12 tháng hoặc custom > 60 ngày)
    const curMonthMap = new Map();
    currentData.eligibleOrders.forEach((o) => {
      const ym = toVietnamDateParts(o.Created_at).yearMonth;
      const refund = currentData.refundMap.get(o.Order_id) || 0;
      const net = Math.max(0, (Number(o.Total_amount) || 0) - refund);
      curMonthMap.set(ym, (curMonthMap.get(ym) || 0) + net);
    });

    const prevMonthMap = new Map();
    previousData.eligibleOrders.forEach((o) => {
      const ym = toVietnamDateParts(o.Created_at).yearMonth;
      const refund = previousData.refundMap.get(o.Order_id) || 0;
      const net = Math.max(0, (Number(o.Total_amount) || 0) - refund);
      prevMonthMap.set(ym, (prevMonthMap.get(ym) || 0) + net);
    });

    let y = startVN.year;
    let m = startVN.month;

    while (y < endVN.year || (y === endVN.year && m <= endVN.month)) {
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      const label = `T${m}/${String(y).slice(2)}`;

      // Tháng tương ứng kỳ trước (lùi 1 năm)
      const prevY = y - 1;
      const prevYm = `${prevY}-${String(m).padStart(2, "0")}`;

      points.push({
        label,
        key: ym,
        netRevenue: curMonthMap.get(ym) || 0,
        prevNetRevenue: prevMonthMap.get(prevYm) || 0,
      });

      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  } else {
    // Gom theo ngày (7 ngày, 30 ngày, 90 ngày)
    const curDayMap = new Map();
    currentData.eligibleOrders.forEach((o) => {
      const d = toVietnamDateParts(o.Created_at).yearMonthDay;
      const refund = currentData.refundMap.get(o.Order_id) || 0;
      const net = Math.max(0, (Number(o.Total_amount) || 0) - refund);
      curDayMap.set(d, (curDayMap.get(d) || 0) + net);
    });

    const prevDayMap = new Map();
    previousData.eligibleOrders.forEach((o) => {
      const d = toVietnamDateParts(o.Created_at).yearMonthDay;
      const refund = previousData.refundMap.get(o.Order_id) || 0;
      const net = Math.max(0, (Number(o.Total_amount) || 0) - refund);
      prevDayMap.set(d, (prevDayMap.get(d) || 0) + net);
    });

    const startVNDate = new Date(Date.UTC(startVN.year, startVN.month - 1, startVN.day));
    const endVNDate = new Date(Date.UTC(endVN.year, endVN.month - 1, endVN.day));
    const startPrevVNDate = new Date(Date.UTC(startPrevVN.year, startPrevVN.month - 1, startPrevVN.day));

    let iter = new Date(startVNDate);
    let dayIndex = 0;

    while (iter <= endVNDate) {
      const y = iter.getUTCFullYear();
      const m = iter.getUTCMonth() + 1;
      const d = iter.getUTCDate();
      const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const label = `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;

      // Ngày tương ứng kỳ trước (theo index ngày)
      const prevDateObj = new Date(startPrevVNDate.getTime() + dayIndex * 24 * 60 * 60 * 1000);
      const prevKey = `${prevDateObj.getUTCFullYear()}-${String(prevDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(prevDateObj.getUTCDate()).padStart(2, "0")}`;

      points.push({
        label,
        key,
        netRevenue: curDayMap.get(key) || 0,
        prevNetRevenue: prevDayMap.get(prevKey) || 0,
      });

      iter.setUTCDate(iter.getUTCDate() + 1);
      dayIndex++;
    }
  }

  return {
    step,
    points,
    totalNetRevenue: points.reduce((s, p) => s + p.netRevenue, 0),
    prevTotalNetRevenue: points.reduce((s, p) => s + p.prevNetRevenue, 0),
  };
}

/**
 * 3. Phễu trạng thái đơn hàng (Order Pipeline)
 */
async function getOrderPipeline(range) {
  const matchFilter = range
    ? { Created_at: { $gte: range.current.start, $lte: range.current.end } }
    : {};

  const orders = await Order.find(matchFilter)
    .select("Order_id Status Status_history Created_at Total_amount")
    .lean();

  const counts = {
    pending_confirmation: 0,
    processing: 0,
    shipping: 0,
    delivered: 0,
    review: 0,
    returning: 0,
    cancelled: 0,
  };

  orders.forEach((o) => {
    const status = o.Status;
    if (status === "cancelled") counts.cancelled++;
    else if (status === "returning") counts.returning++;
    else if (status === "delivered") counts.delivered++;
    else if (status === "review") counts.review++;
    else if (status === "shipping") counts.shipping++;
    else if (status === "processing" || status === "pending_payment") {
      if (isOrderConfirmed(o)) {
        counts.processing++;
      } else {
        counts.pending_confirmation++;
      }
    } else {
      counts.processing++;
    }
  });

  const total = orders.length;

  const pipeline = [
    { key: "pending_confirmation", label: "Chờ xác nhận", count: counts.pending_confirmation, color: "#f59e0b" },
    { key: "processing", label: "Đang xử lý / Kho", count: counts.processing, color: "#3b82f6" },
    { key: "shipping", label: "Đang giao hàng", count: counts.shipping, color: "#8b5cf6" },
    { key: "delivered", label: "Đã giao hàng", count: counts.delivered, color: "#10b981" },
    { key: "review", label: "Đã đánh giá / Hoàn tất", count: counts.review, color: "#059669" },
    { key: "returning", label: "Đang đổi trả", count: counts.returning, color: "#ec4899" },
    { key: "cancelled", label: "Đã hủy", count: counts.cancelled, color: "#ef4444" },
  ].map((item) => ({
    ...item,
    percentage: total > 0 ? Number(((item.count / total) * 100).toFixed(1)) : 0,
  }));

  return {
    total,
    pipeline,
  };
}

/**
 * 4. Phân tích thanh toán theo trạng thái và phương thức
 */
async function getPaymentBreakdown(range) {
  const matchFilter = range
    ? {
        Order_id: {
          $in: await Order.distinct("Order_id", {
            Created_at: { $gte: range.current.start, $lte: range.current.end },
          }),
        },
      }
    : {};

  const payments = await Payment.find(matchFilter)
    .select("Payment_id Order_id Payment_type Payment_status Amount Paid_at")
    .lean();

  const totalPayments = payments.length;

  // Theo trạng thái
  const statusCounts = { paid: 0, pending: 0, failed: 0, refunded: 0 };
  const statusAmounts = { paid: 0, pending: 0, failed: 0, refunded: 0 };

  // Theo phương thức
  const methodMap = {
    COD: { total: 0, paid: 0, pending: 0, failed: 0, refunded: 0, amount: 0 },
    VNPay: { total: 0, paid: 0, pending: 0, failed: 0, refunded: 0, amount: 0 },
    MoMo: { total: 0, paid: 0, pending: 0, failed: 0, refunded: 0, amount: 0 },
    BankTransfer: { total: 0, paid: 0, pending: 0, failed: 0, refunded: 0, amount: 0 },
  };

  payments.forEach((p) => {
    const s = p.Payment_status || "pending";
    const t = p.Payment_type || "COD";
    const amt = Number(p.Amount) || 0;

    if (statusCounts[s] !== undefined) {
      statusCounts[s]++;
      statusAmounts[s] += amt;
    }

    if (methodMap[t]) {
      methodMap[t].total++;
      if (methodMap[t][s] !== undefined) methodMap[t][s]++;
      if (s === "paid") methodMap[t].amount += amt;
    }
  });

  const byStatus = [
    { key: "paid", label: "Đã thanh toán", count: statusCounts.paid, amount: statusAmounts.paid, color: "#10b981" },
    { key: "pending", label: "Chờ thanh toán / Thu tiền", count: statusCounts.pending, amount: statusAmounts.pending, color: "#f59e0b" },
    { key: "failed", label: "Thất bại / Hủy", count: statusCounts.failed, amount: statusAmounts.failed, color: "#ef4444" },
    { key: "refunded", label: "Đã hoàn tiền", count: statusCounts.refunded, amount: statusAmounts.refunded, color: "#6366f1" },
  ].map((item) => ({
    ...item,
    percentage: totalPayments > 0 ? Number(((item.count / totalPayments) * 100).toFixed(1)) : 0,
  }));

  const byMethod = Object.entries(methodMap).map(([method, data]) => {
    // Tỷ lệ đạt theo phương thức tính trên giao dịch đã có kết quả (paid + failed)
    const resolved = data.paid + data.failed;
    const successRate = resolved > 0 ? Number(((data.paid / resolved) * 100).toFixed(1)) : (data.total > 0 && data.pending === data.total ? 0 : 0);
    return {
      method,
      total: data.total,
      paid: data.paid,
      pending: data.pending,
      failed: data.failed,
      refunded: data.refunded,
      paidAmount: data.amount,
      successRate,
    };
  });

  // DEF-04: Phân tách rõ ràng giữa Online Pre-payment và COD Post-delivery
  const onlineMethods = ["VNPay", "MoMo", "BankTransfer"];
  const onlineTotal = onlineMethods.reduce((sum, m) => sum + methodMap[m].total, 0);
  const onlinePaid = onlineMethods.reduce((sum, m) => sum + methodMap[m].paid, 0);
  const onlineFailed = onlineMethods.reduce((sum, m) => sum + methodMap[m].failed, 0);
  const onlinePending = onlineMethods.reduce((sum, m) => sum + methodMap[m].pending, 0);
  const onlineRefunded = onlineMethods.reduce((sum, m) => sum + methodMap[m].refunded, 0);
  const onlineResolved = onlinePaid + onlineFailed;
  const onlineSuccessRate = onlineResolved > 0 ? Number(((onlinePaid / onlineResolved) * 100).toFixed(1)) : 0;

  const codData = methodMap["COD"];
  const codResolved = codData.paid + codData.failed;
  const codSuccessRate = codResolved > 0 ? Number(((codData.paid / codResolved) * 100).toFixed(1)) : 0;

  // Tỷ lệ thanh toán thành công trên các giao dịch đã chốt (loại trừ pending đang xử lý/chưa đến hạn)
  const totalResolved = statusCounts.paid + statusCounts.failed;
  const overallSuccessRate = totalResolved > 0
    ? Number(((statusCounts.paid / totalResolved) * 100).toFixed(1))
    : 0;

  return {
    totalPayments,
    byStatus,
    byMethod,
    overallSuccessRate,
    onlineFlow: {
      total: onlineTotal,
      paid: onlinePaid,
      failed: onlineFailed,
      pending: onlinePending,
      refunded: onlineRefunded,
      successRate: onlineSuccessRate,
      tooltip: "Tỷ lệ thanh toán trực tuyến thành công = Paid / (Paid + Failed). Đơn BankTransfer pending không bị tính là thất bại.",
    },
    codFlow: {
      total: codData.total,
      paid: codData.paid,
      pending: codData.pending,
      failed: codData.failed,
      successRate: codSuccessRate,
      tooltip: "Đơn COD pending đang trong kho/luân chuyển chưa phát sinh nghĩa vụ thu tiền. Tỷ lệ thành công tính trên đơn đã hoàn tất phát hàng.",
    },
  };
}

/**
 * 5. Hiệu quả của các đối tác vận chuyển
 */
async function getCarrierPerformance(range) {
  const matchFilter = range
    ? {
        Order_id: {
          $in: await Order.distinct("Order_id", {
            Created_at: { $gte: range.current.start, $lte: range.current.end },
          }),
        },
      }
    : {};

  const deliveries = await Delivery.find(matchFilter)
    .select("Delivery_id Order_id Shipping_partner Status Delivered_at")
    .lean();

  const partnerMap = {
    "Viettel Post": { total: 0, delivered: 0, failed: 0, pending: 0 },
    "Giao Hàng Nhanh": { total: 0, delivered: 0, failed: 0, pending: 0 },
  };

  deliveries.forEach((d) => {
    const p = d.Shipping_partner || "Khác";
    if (!partnerMap[p]) {
      partnerMap[p] = { total: 0, delivered: 0, failed: 0, pending: 0 };
    }
    partnerMap[p].total++;
    if (d.Status === "delivered") partnerMap[p].delivered++;
    else if (d.Status === "failed") partnerMap[p].failed++;
    else partnerMap[p].pending++;
  });

  const partners = Object.entries(partnerMap).map(([partner, stat]) => {
    const completed = stat.delivered + stat.failed;
    const successRate = completed > 0 ? Number(((stat.delivered / completed) * 100).toFixed(1)) : 0;
    return {
      partner,
      total: stat.total,
      delivered: stat.delivered,
      failed: stat.failed,
      pending: stat.pending,
      successRate,
    };
  });

  const totalAll = deliveries.length;
  const deliveredAll = deliveries.filter((d) => d.Status === "delivered").length;
  const failedAll = deliveries.filter((d) => d.Status === "failed").length;
  const completedAll = deliveredAll + failedAll;

  return {
    totalDeliveries: totalAll,
    partners,
    overallRate: completedAll > 0 ? Number(((deliveredAll / completedAll) * 100).toFixed(1)) : 0,
  };
}

/**
 * 6. Cảnh báo vận hành (Operational Alerts) dựa trên bằng chứng dữ liệu thực tế
 */
async function getOperationalAlerts() {
  const now = new Date();
  const alerts = [];

  // 1. Đơn xử lý kho quá hạn SLA
  const overdueOrders = await Order.aggregate([
    { $match: { Status: "processing" } },
    {
      $lookup: {
        from: "Payment",
        localField: "Order_id",
        foreignField: "Order_id",
        as: "PaymentInfo",
      },
    },
    { $unwind: { path: "$PaymentInfo", preserveNullAndEmptyArrays: true } },
    ...buildSlaStages(now),
    { $match: { Is_overdue: true } },
    { $project: { Order_id: 1, Sla_stage: 1, Overdue_seconds: 1 } },
  ]);

  if (overdueOrders.length > 0) {
    alerts.push({
      id: "sla_overdue_orders",
      level: "critical",
      title: "Đơn hàng quá hạn SLA xử lý kho",
      message: `Hiện có ${overdueOrders.length} đơn hàng đang trong trạng thái xử lý đã vượt quá thời hạn SLA cam kết.`,
      count: overdueOrders.length,
      sampleIds: overdueOrders.slice(0, 3).map((o) => o.Order_id),
      link: "/admin/orders?status=overdue",
      actionText: "Xem đơn quá hạn",
    });
  }

  // 2. Yêu cầu đổi trả đang chờ duyệt (Pending Returns)
  const pendingReturns = await Return_order.find({ Status: "pending" })
    .select("Return_order_id Order_id Created_at Refund_amount")
    .sort({ Created_at: 1 })
    .lean();

  if (pendingReturns.length > 0) {
    alerts.push({
      id: "pending_returns",
      level: "warning",
      title: "Yêu cầu đổi trả đang chờ xử lý",
      message: `Có ${pendingReturns.length} yêu cầu đổi trả của khách hàng đang ở trạng thái Chờ duyệt.`,
      count: pendingReturns.length,
      sampleIds: pendingReturns.slice(0, 3).map((r) => r.Return_order_id),
      link: "/admin/returns?status=pending",
      actionText: "Duyệt yêu cầu ngay",
    });
  }

  // 3. Đơn chuyển khoản ngân hàng chờ xác nhận thanh toán
  const pendingBankOrders = await Order.find({ Status: "pending_payment" })
    .select("Order_id Total_amount Created_at")
    .lean();

  if (pendingBankOrders.length > 0) {
    alerts.push({
      id: "pending_bank_orders",
      level: "info",
      title: "Đơn hàng chuyển khoản chờ thanh toán",
      message: `Có ${pendingBankOrders.length} đơn hàng chuyển khoản ngân hàng đang chờ khách thanh toán hoặc đối soát.`,
      count: pendingBankOrders.length,
      sampleIds: pendingBankOrders.slice(0, 3).map((o) => o.Order_id),
      link: "/admin/orders?status=pending_payment&paymentType=BankTransfer",
      actionText: "Xem đơn chuyển khoản",
    });
  }

  return alerts;
}

/**
 * Tính toán số liệu Giá vốn (COGS), Lợi nhuận gộp (Gross Profit) và Tỷ lệ bao phủ (Phase 2)
 */
async function calculateProfitMetrics(startDate, endDate) {
  const netMetrics = await getEligibleOrdersWithReturns(startDate, endDate);
  const eligibleOrderIds = netMetrics.eligibleOrders.map((o) => o.Order_id);

  let trackedCogs = 0;
  let trackedRevenue = 0;
  let totalRevenueFromItems = 0;
  let trackedItemsCount = 0;
  let totalItemsCount = 0;
  const catTotals = {};

  if (eligibleOrderIds.length > 0) {
    const [orderDetails, categories, products, variants] = await Promise.all([
      Order_detail.find({
        Order_id: { $in: eligibleOrderIds },
      })
        .select("Order_id Product_variant_id Quantity Total_price Price Cost_price_at_sale Cost_status Discount_allocated Net_line_revenue")
        .lean(),
      Category.find({}, "Category_id Category_name").lean().catch(() => []),
      Product.find({}, "Product_id Category_id").lean().catch(() => []),
      Product_variant.find({}, "Product_variant_id Product_id").lean().catch(() => []),
    ]);

    const catMap = new Map();
    categories.forEach((c) => catMap.set(c.Category_id, c.Category_name));

    const prodCatMap = new Map();
    products.forEach((p) => prodCatMap.set(p.Product_id, p.Category_id));

    const variantCatMap = new Map();
    variants.forEach((v) => {
      const catId = prodCatMap.get(v.Product_id) || "OTHER";
      const catName = catMap.get(catId) || "Sản phẩm khác";
      variantCatMap.set(v.Product_variant_id, { categoryId: catId, categoryName: catName });
    });

    orderDetails.forEach((item) => {
      const qty = Math.max(1, Number(item.Quantity) || 1);
      const itemNetRevenue = item.Net_line_revenue !== undefined && item.Net_line_revenue !== null
        ? Number(item.Net_line_revenue)
        : Number(item.Total_price) || 0;
      totalRevenueFromItems += itemNetRevenue;
      totalItemsCount += qty;

      let itemCogs = 0;
      if (
        item.Cost_status === "tracked" &&
        item.Cost_price_at_sale !== null &&
        item.Cost_price_at_sale !== undefined &&
        Number(item.Cost_price_at_sale) >= 0
      ) {
        const costPrice = Number(item.Cost_price_at_sale) || 0;
        itemCogs = costPrice * qty;
        trackedCogs += itemCogs;
        trackedRevenue += itemNetRevenue;
        trackedItemsCount += qty;
      }

      // Tích lũy cơ cấu giá vốn theo danh mục sản phẩm
      const catInfo = variantCatMap.get(item.Product_variant_id) || { categoryId: "OTHER", categoryName: "Sản phẩm khác" };
      if (!catTotals[catInfo.categoryId]) {
        catTotals[catInfo.categoryId] = {
          categoryId: catInfo.categoryId,
          categoryName: catInfo.categoryName,
          cogs: 0,
          revenue: 0,
          itemCount: 0,
        };
      }
      catTotals[catInfo.categoryId].cogs += itemCogs;
      catTotals[catInfo.categoryId].revenue += itemNetRevenue;
      catTotals[catInfo.categoryId].itemCount += qty;
    });
  }

  const netRevenue = netMetrics.netRevenue;
  const costCoverage = totalRevenueFromItems > 0
    ? Number(((trackedRevenue / totalRevenueFromItems) * 100).toFixed(2))
    : 0;

  // 1. Phân loại trạng thái bao phủ
  let coverageStatus = "zero";
  if (costCoverage >= 100) {
    coverageStatus = "complete";
  } else if (costCoverage > 0) {
    coverageStatus = "partial";
  }

  // 2. Chỉ tiêu riêng của phần sản phẩm đã có giá vốn (Tracked)
  let trackedGrossProfit = null;
  let trackedGrossMargin = null;
  if (coverageStatus !== "zero") {
    trackedGrossProfit = Math.round(trackedRevenue - trackedCogs);
    trackedGrossMargin = trackedRevenue > 0
      ? Number(((trackedGrossProfit / trackedRevenue) * 100).toFixed(2))
      : 0;
  }

  // 3. Lợi nhuận gộp toàn kỳ (Overall)
  // Quy tắc bắt buộc: Chỉ tính toàn kỳ khi Cost Coverage đạt 100%
  let grossProfit = null;
  let grossMargin = null;
  if (coverageStatus === "complete") {
    grossProfit = Math.round(netRevenue - trackedCogs);
    grossMargin = netRevenue > 0
      ? Number(((grossProfit / netRevenue) * 100).toFixed(2))
      : 0;
  }

  return {
    orderCount: netMetrics.orderCount,
    netRevenue,
    cogs: trackedCogs,
    grossProfit,
    grossMargin,
    trackedGrossProfit,
    trackedGrossMargin,
    costCoverage,
    coverageStatus,
    trackedRevenue,
    totalRevenueFromItems,
    trackedItemsCount,
    totalItemsCount,
    categoryTotals: catTotals,
    eligibleOrders: netMetrics.eligibleOrders,
    refundMap: netMetrics.refundMap,
  };
}

/**
 * 7. KPI Lợi nhuận và Giá vốn (Phase 2)
 */
async function getProfitSummary(range) {
  const current = await calculateProfitMetrics(range.current.start, range.current.end);
  const previous = await calculateProfitMetrics(range.previous.start, range.previous.end);

  const isComplete = current.coverageStatus === "complete";
  const isZeroCoverage = current.coverageStatus === "zero";

  let warning = null;
  if (isZeroCoverage) {
    warning = "Chưa có sản phẩm nào trong kỳ được ghi nhận giá vốn (Độ bao phủ: 0%). Lợi nhuận gộp toàn kỳ chưa thể xác định.";
  } else if (!isComplete) {
    warning = `Dữ liệu giá vốn đạt ${current.costCoverage}% (${current.trackedItemsCount}/${current.totalItemsCount} sản phẩm bán ra). Lợi nhuận gộp toàn kỳ chưa đủ dữ liệu để tính toán; chỉ hiển thị chỉ tiêu riêng của phần sản phẩm đã có giá vốn.`;
  }

  return {
    netRevenue: {
      value: current.netRevenue,
      prevValue: previous.netRevenue,
      ...calculateDelta(current.netRevenue, previous.netRevenue),
      tooltip: "Doanh thu thuần từ các đơn đã giao thành công và đơn đổi trả đã chốt kết quả, trừ tiền hoàn trả thực tế.",
    },
    cogs: {
      value: current.cogs,
      prevValue: previous.cogs,
      status: isZeroCoverage ? "unrecorded" : "tracked",
      ...calculateDelta(current.cogs, previous.cogs),
      tooltip: isZeroCoverage
        ? "Chưa có sản phẩm nào được ghi nhận giá vốn trong kỳ này."
        : "Giá vốn hàng bán (COGS) tính từ các mặt hàng đã được cấu hình giá vốn chuẩn.",
    },
    grossProfit: {
      value: current.grossProfit, // null nếu coverage < 100%
      prevValue: previous.grossProfit,
      ...calculateDelta(current.grossProfit, previous.grossProfit),
      trackedValue: current.trackedGrossProfit,
      trackedPrevValue: previous.trackedGrossProfit,
      coverageStatus: current.coverageStatus,
      tooltip: isComplete
        ? "Lợi nhuận gộp toàn kỳ = Doanh thu thuần - Giá vốn hàng bán."
        : (!isZeroCoverage
          ? "Chưa đủ dữ liệu lợi nhuận gộp toàn kỳ do độ bao phủ giá vốn < 100%. Phần sản phẩm có giá vốn đạt lợi nhuận: " + (current.trackedGrossProfit !== null ? current.trackedGrossProfit.toLocaleString("vi-VN") + " đ" : "-")
          : "Chưa đủ dữ liệu do chưa có sản phẩm nào ghi nhận giá vốn."),
    },
    grossMargin: {
      value: current.grossMargin, // null nếu coverage < 100%
      prevValue: previous.grossMargin,
      ...calculateDelta(current.grossMargin, previous.grossMargin),
      trackedValue: current.trackedGrossMargin,
      trackedPrevValue: previous.trackedGrossMargin,
      coverageStatus: current.coverageStatus,
      tooltip: isComplete
        ? "Biên lợi nhuận gộp toàn kỳ = (Lợi nhuận gộp / Doanh thu thuần) * 100%."
        : (!isZeroCoverage
          ? "Chưa đủ dữ liệu biên lợi nhuận gộp toàn kỳ. Biên lãi gộp trên phần sản phẩm có giá vốn đạt: " + (current.trackedGrossMargin !== null ? current.trackedGrossMargin + "%" : "-")
          : "Chưa đủ dữ liệu do chưa có sản phẩm nào ghi nhận giá vốn."),
    },
    costCoverage: {
      ratio: current.costCoverage,
      coverageStatus: current.coverageStatus,
      trackedRevenue: current.trackedRevenue,
      totalRevenue: current.totalRevenueFromItems,
      trackedItems: current.trackedItemsCount,
      totalItems: current.totalItemsCount,
      isComplete,
      warning,
    },
    categoryBreakdown: (() => {
      const allCatIds = new Set([
        ...Object.keys(current.categoryTotals || {}),
        ...Object.keys(previous.categoryTotals || {}),
      ]);

      const list = Array.from(allCatIds).map((catId) => {
        const curCat = current.categoryTotals?.[catId];
        const prevCat = previous.categoryTotals?.[catId];
        const categoryName = curCat?.categoryName || prevCat?.categoryName || "Khác";
        const cogs = curCat ? curCat.cogs : 0;
        const prevCogs = prevCat ? prevCat.cogs : 0;
        const revenue = curCat ? curCat.revenue : 0;
        const costShare = current.cogs > 0
          ? Number(((cogs / current.cogs) * 100).toFixed(1))
          : 0;

        let diffPercent = null;
        if (prevCogs > 0) {
          diffPercent = Number((((cogs - prevCogs) / prevCogs) * 100).toFixed(1));
        }

        return {
          categoryId: catId,
          categoryName,
          cogs,
          prevCogs,
          revenue,
          costShare,
          diffPercent,
          itemCount: curCat?.itemCount || 0,
        };
      });

      list.sort((a, b) => b.cogs - a.cogs);
      // Chỉ giữ các nhóm hàng thực sự có phát sinh giá vốn trong kỳ hiện tại
      return list.filter((item) => item.cogs > 0);
    })(),
    periodInfo: {
      currentStart: range.current.start,
      currentEnd: range.current.end,
      previousStart: range.previous.start,
      previousEnd: range.previous.end,
    },
  };
}

/**
 * 8. Biểu đồ xu hướng Doanh thu vs Lợi nhuận gộp theo chuỗi thời gian (Phase 2)
 */
async function getProfitTrend(range) {
  const { current, previous, step } = range;

  const currentProfit = await calculateProfitMetrics(current.start, current.end);
  const curOrderIds = currentProfit.eligibleOrders.map((o) => o.Order_id);

  const curDetails = curOrderIds.length > 0
    ? await Order_detail.find({ Order_id: { $in: curOrderIds } })
        .select("Order_id Quantity Cost_price_at_sale Cost_status Net_line_revenue Total_price")
        .lean()
    : [];

  const orderCostMap = new Map();
  const orderTrackedRevMap = new Map();
  const orderTotalRevMap = new Map();

  curDetails.forEach((item) => {
    const qty = Math.max(1, Number(item.Quantity) || 1);
    const itemNetRevenue = item.Net_line_revenue !== undefined && item.Net_line_revenue !== null
      ? Number(item.Net_line_revenue)
      : Number(item.Total_price) || 0;

    orderTotalRevMap.set(item.Order_id, (orderTotalRevMap.get(item.Order_id) || 0) + itemNetRevenue);

    if (
      item.Cost_status === "tracked" &&
      item.Cost_price_at_sale !== null &&
      item.Cost_price_at_sale !== undefined &&
      Number(item.Cost_price_at_sale) >= 0
    ) {
      const costPrice = Number(item.Cost_price_at_sale) || 0;
      const c = costPrice * qty;
      orderCostMap.set(item.Order_id, (orderCostMap.get(item.Order_id) || 0) + c);
      orderTrackedRevMap.set(item.Order_id, (orderTrackedRevMap.get(item.Order_id) || 0) + itemNetRevenue);
    }
  });

  const points = [];
  const startVN = toVietnamDateParts(current.start);
  const endVN = toVietnamDateParts(current.end);

  if (step === "month") {
    const curMonthRevMap = new Map();
    const curMonthCostMap = new Map();
    const curMonthTrackedRevMap = new Map();
    const curMonthTotalRevMap = new Map();

    currentProfit.eligibleOrders.forEach((o) => {
      const ym = toVietnamDateParts(o.Created_at).yearMonth;
      const refund = currentProfit.refundMap.get(o.Order_id) || 0;
      const net = Math.max(0, (Number(o.Total_amount) || 0) - refund);
      const cost = orderCostMap.get(o.Order_id) || 0;
      const trackedRev = orderTrackedRevMap.get(o.Order_id) || 0;
      const totalRev = orderTotalRevMap.get(o.Order_id) || 0;

      curMonthRevMap.set(ym, (curMonthRevMap.get(ym) || 0) + net);
      curMonthCostMap.set(ym, (curMonthCostMap.get(ym) || 0) + cost);
      curMonthTrackedRevMap.set(ym, (curMonthTrackedRevMap.get(ym) || 0) + trackedRev);
      curMonthTotalRevMap.set(ym, (curMonthTotalRevMap.get(ym) || 0) + totalRev);
    });

    let y = startVN.year;
    let m = startVN.month;

    while (y < endVN.year || (y === endVN.year && m <= endVN.month)) {
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      const label = `T${m}/${String(y).slice(2)}`;
      const netRevenue = curMonthRevMap.get(ym) || 0;
      const cogs = curMonthCostMap.get(ym) || 0;
      const trackedRev = curMonthTrackedRevMap.get(ym) || 0;
      const totalRev = curMonthTotalRevMap.get(ym) || 0;

      const pointCoverage = totalRev > 0 ? Number(((trackedRev / totalRev) * 100).toFixed(2)) : 0;

      let grossProfit = null;
      let grossMargin = null;
      let trackedGrossProfit = null;
      let trackedGrossMargin = null;

      if (pointCoverage >= 100 && totalRev > 0) {
        grossProfit = Math.round(netRevenue - cogs);
        grossMargin = netRevenue > 0 ? Number(((grossProfit / netRevenue) * 100).toFixed(2)) : 0;
        trackedGrossProfit = grossProfit;
        trackedGrossMargin = grossMargin;
      } else if (trackedRev > 0) {
        trackedGrossProfit = Math.round(trackedRev - cogs);
        trackedGrossMargin = Number(((trackedGrossProfit / trackedRev) * 100).toFixed(2));
      }

      points.push({
        label,
        key: ym,
        netRevenue,
        cogs,
        grossProfit,
        grossMargin,
        trackedGrossProfit,
        trackedGrossMargin,
        costCoverage: pointCoverage,
      });

      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
  } else {
    const curDayRevMap = new Map();
    const curDayCostMap = new Map();
    const curDayTrackedRevMap = new Map();
    const curDayTotalRevMap = new Map();

    currentProfit.eligibleOrders.forEach((o) => {
      const d = toVietnamDateParts(o.Created_at).yearMonthDay;
      const refund = currentProfit.refundMap.get(o.Order_id) || 0;
      const net = Math.max(0, (Number(o.Total_amount) || 0) - refund);
      const cost = orderCostMap.get(o.Order_id) || 0;
      const trackedRev = orderTrackedRevMap.get(o.Order_id) || 0;
      const totalRev = orderTotalRevMap.get(o.Order_id) || 0;

      curDayRevMap.set(d, (curDayRevMap.get(d) || 0) + net);
      curDayCostMap.set(d, (curDayCostMap.get(d) || 0) + cost);
      curDayTrackedRevMap.set(d, (curDayTrackedRevMap.get(d) || 0) + trackedRev);
      curDayTotalRevMap.set(d, (curDayTotalRevMap.get(d) || 0) + totalRev);
    });

    const startVNDate = new Date(Date.UTC(startVN.year, startVN.month - 1, startVN.day));
    const endVNDate = new Date(Date.UTC(endVN.year, endVN.month - 1, endVN.day));

    let iter = new Date(startVNDate);

    while (iter <= endVNDate) {
      const y = iter.getUTCFullYear();
      const m = iter.getUTCMonth() + 1;
      const d = iter.getUTCDate();
      const key = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const label = `${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;

      const netRevenue = curDayRevMap.get(key) || 0;
      const cogs = curDayCostMap.get(key) || 0;
      const trackedRev = curDayTrackedRevMap.get(key) || 0;
      const totalRev = curDayTotalRevMap.get(key) || 0;

      const pointCoverage = totalRev > 0 ? Number(((trackedRev / totalRev) * 100).toFixed(2)) : 0;

      let grossProfit = null;
      let grossMargin = null;
      let trackedGrossProfit = null;
      let trackedGrossMargin = null;

      if (pointCoverage >= 100 && totalRev > 0) {
        grossProfit = Math.round(netRevenue - cogs);
        grossMargin = netRevenue > 0 ? Number(((grossProfit / netRevenue) * 100).toFixed(2)) : 0;
        trackedGrossProfit = grossProfit;
        trackedGrossMargin = grossMargin;
      } else if (trackedRev > 0) {
        trackedGrossProfit = Math.round(trackedRev - cogs);
        trackedGrossMargin = Number(((trackedGrossProfit / trackedRev) * 100).toFixed(2));
      }

      points.push({
        label,
        key,
        netRevenue,
        cogs,
        grossProfit,
        grossMargin,
        trackedGrossProfit,
        trackedGrossMargin,
        costCoverage: pointCoverage,
      });

      iter.setUTCDate(iter.getUTCDate() + 1);
    }
  }

  const totalNetRevenue = points.reduce((s, p) => s + p.netRevenue, 0);
  const totalCogs = points.reduce((s, p) => s + p.cogs, 0);
  const isOverallComplete = currentProfit.coverageStatus === "complete";
  const totalGrossProfit = isOverallComplete ? Math.round(totalNetRevenue - totalCogs) : null;
  const overallGrossMargin = (isOverallComplete && totalNetRevenue > 0)
    ? Number(((totalGrossProfit / totalNetRevenue) * 100).toFixed(2))
    : null;

  return {
    step,
    points,
    totalNetRevenue,
    totalCogs,
    totalGrossProfit,
    overallGrossMargin,
    totalTrackedGrossProfit: currentProfit.trackedGrossProfit,
    overallTrackedGrossMargin: currentProfit.trackedGrossMargin,
    overallCostCoverage: currentProfit.costCoverage,
  };
}

module.exports = {
  parsePeriod,
  getSummaryCards,
  getRevenueTrend,
  getOrderPipeline,
  getPaymentBreakdown,
  getCarrierPerformance,
  getOperationalAlerts,
  getProfitSummary,
  getProfitTrend,
};
