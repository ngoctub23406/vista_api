// VISTA AI Management Assistant – Controller (Giai đoạn 2: Data Retrieval & Context Building)
// Nhiệm vụ:
// 1. Phân loại câu hỏi bằng Rules đơn giản (không gọi AI).
// 2. Chốt chặn RBAC nghiêm ngặt: Staff tuyệt đối không được truy xuất dữ liệu tài chính.
// 3. Truy xuất dữ liệu thực tế từ Dashboard Service, Order, Return_order, Review (Read-only).
// 4. Đóng gói Context có cấu trúc chuẩn cho Giai đoạn 3 (Groq AI).

const mongoose = require("mongoose");
const dashboardService = require("../../services/dashboard.service");
const assistantAiService = require("../../services/assistant-ai.service");
const { Order, Return_order, Review } = require("../../models/schema");
const { buildSlaStages } = require("../../services/order-sla.service");

// ─────────────────────────────────────────────────────────
// GIỚI HẠN ĐẦU VÀO
// ─────────────────────────────────────────────────────────
const MESSAGE_MIN_LENGTH = 1;
const MESSAGE_MAX_LENGTH = 1000;
const MAX_HISTORY_ITEMS = 10;
const MAX_SAMPLE_ITEMS = 5;

/**
 * Kiểm tra kết nối MongoDB an toàn để tránh buffer timeout khi DB chưa kết nối
 */
function isDatabaseConnected() {
  if (exports.isDatabaseConnected && exports.isDatabaseConnected !== isDatabaseConnected) {
    return exports.isDatabaseConnected();
  }
  return Boolean(mongoose.connection && mongoose.connection.readyState === 1);
}

// ─────────────────────────────────────────────────────────
// PHÂN LOẠI INTENT (Backend Rules)
// Thứ tự ưu tiên:
// 1. financial_kpi  -> Ưu tiên hàng đầu để chặn Staff ngay lập tức nếu có yếu tố tài chính.
// 2. general_policy -> Hỏi quy trình / hướng dẫn (không query MongoDB).
// 3. return_issue   -> Đổi trả, hoàn hàng.
// 4. review_moderation -> Kiểm duyệt đánh giá.
// 5. order_operational -> Vận hành đơn hàng, SLA.
// 6. unsupported    -> Ngoài phạm vi hỗ trợ.
// ─────────────────────────────────────────────────────────
const INTENT_RULES = [
  {
    intent: "financial_kpi",
    keywords: [
      // Doanh thu & Doanh số
      "doanh thu", "doanh số", "revenue",
      // Lợi nhuận
      "lợi nhuận", "gross profit", "profit",
      // Giá vốn
      "giá vốn", "cogs",
      // Biên lợi nhuận
      "gross margin", "biên lợi nhuận", "margin",
      // Cost coverage
      "cost coverage", "độ bao phủ", "bao phủ giá vốn", "độ bao phủ giá vốn",
      // KPI & Chỉ số tài chính
      "tài chính", "kpi", "aov", "giá trị đơn trung bình", "giá trị trung bình đơn",
      "kinh doanh tháng", "kinh doanh tuần", "kinh doanh hôm nay",
      "tổng quan kinh doanh", "tình hình kinh doanh", "báo cáo kinh doanh",
      "summary card", "thu nhập",
    ],
  },
  {
    intent: "general_policy",
    keywords: [
      "quy trình", "hướng dẫn", "chính sách", "quy định",
      "làm thế nào", "làm sao để", "làm sao", "phải làm gì",
      "cách xử lý", "bước xử lý", "sop", "tiêu chuẩn",
      "thời hạn đổi trả", "điều kiện đổi trả", "thời gian đổi trả",
      "chính sách sla", "quy định sla", "quy tắc", "nội quy",
    ],
  },
  {
    intent: "return_issue",
    keywords: [
      "đổi trả", "hoàn hàng", "yêu cầu đổi", "yêu cầu trả",
      "hậu mãi", "refund", "hoàn tiền", "tiếp nhận hàng",
      "kiểm định hàng", "yêu cầu hoàn", "return order",
      "đơn đổi", "đơn trả", "khiếu nại",
    ],
  },
  {
    intent: "review_moderation",
    keywords: [
      "đánh giá", "review", "kiểm duyệt", "phản hồi đánh giá",
      "duyệt đánh giá", "đánh giá chờ", "đánh giá tiêu cực",
      "1 sao", "2 sao", "sao thấp", "rating thấp",
      "chưa phản hồi", "pending review",
    ],
  },
  {
    intent: "order_operational",
    keywords: [
      "đơn hàng", "order", "đơn chờ", "chờ xác nhận",
      "quá hạn", "overdue", "sla", "bàn giao", "xác nhận đơn",
      "giao hàng", "vận chuyển", "đơn pending",
      "pending_confirmation", "processing",
      "đơn nào cần", "đơn cần chú ý", "chờ xử lý", "xử lý đơn",
      "đóng gói", "bưu tá",
    ],
  },
];

/**
 * Phân loại intent từ nội dung câu hỏi.
 */
function detectIntent(message) {
  const normalised = message.toLowerCase().trim();

  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((kw) => normalised.includes(kw))) {
      return rule.intent;
    }
  }

  return "unsupported";
}

// ─────────────────────────────────────────────────────────
// KIỂM TRA QUYỀN (RBAC)
// ─────────────────────────────────────────────────────────
const MANAGER_ALLOWED_INTENTS = new Set([
  "financial_kpi",
  "order_operational",
  "return_issue",
  "review_moderation",
  "general_policy",
  "unsupported",
]);

const STAFF_ALLOWED_INTENTS = new Set([
  "order_operational",
  "return_issue",
  "review_moderation",
  "general_policy",
  "unsupported",
]);

function isIntentAllowed(role, intent) {
  if (role === "Manager") {
    return MANAGER_ALLOWED_INTENTS.has(intent);
  }
  if (role === "Staff") {
    return STAFF_ALLOWED_INTENTS.has(intent);
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// VALIDATE INPUT
// ─────────────────────────────────────────────────────────
function validateMessage(message) {
  if (message === undefined || message === null) {
    return "Trường message là bắt buộc.";
  }
  if (typeof message !== "string") {
    return "Trường message phải là chuỗi ký tự.";
  }
  const trimmed = message.trim();
  if (trimmed.length < MESSAGE_MIN_LENGTH) {
    return "Câu hỏi không được để trống.";
  }
  if (trimmed.length > MESSAGE_MAX_LENGTH) {
    return `Câu hỏi quá dài. Tối đa ${MESSAGE_MAX_LENGTH} ký tự.`;
  }
  return null;
}

function sanitiseHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];

  return rawHistory
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.content === "string" &&
        item.content.trim().length > 0 &&
        (item.role === "user" || item.role === "assistant")
    )
    .slice(-MAX_HISTORY_ITEMS)
    .map((item) => ({
      role: item.role,
      content: item.content.trim().slice(0, MESSAGE_MAX_LENGTH),
    }));
}

// ─────────────────────────────────────────────────────────
// TRUY XUẤT DỮ LIỆU THEO INTENT (Data Retrieval Functions)
// ─────────────────────────────────────────────────────────

/**
 * 1. Financial KPI (Chỉ Manager được phép gọi)
 * Tái sử dụng: dashboardService.getSummaryCards và getProfitSummary
 */
async function getFinancialKpiData(role) {
  // Chốt chặn kép tại tầng hàm dữ liệu:
  if (role !== "Manager") {
    const error = new Error("RBAC Violation: Non-manager cannot access financial KPI data");
    error.code = "ROLE_DENIED";
    throw error;
  }

  if (!isDatabaseConnected()) {
    return {
      data_available: false,
      data: null,
      note: "Cơ sở dữ liệu chưa kết nối.",
    };
  }

  const range = dashboardService.parsePeriod("30days");
  const [summaryCards, profitSummary] = await Promise.all([
    dashboardService.getSummaryCards(range),
    dashboardService.getProfitSummary(range),
  ]);

  const hasData = Boolean(
    summaryCards &&
    summaryCards.netRevenue &&
    typeof summaryCards.netRevenue.value === "number"
  );

  return {
    data_available: hasData,
    data: hasData
      ? {
          period: "30days",
          periodInfo: summaryCards.periodInfo || null,
          netRevenue: {
            value: summaryCards.netRevenue?.value ?? 0,
            prevValue: summaryCards.netRevenue?.prevValue ?? 0,
            diff: summaryCards.netRevenue?.diff ?? 0,
            percent: summaryCards.netRevenue?.percent ?? 0,
          },
          completedOrders: {
            value: summaryCards.completedOrders?.value ?? 0,
            prevValue: summaryCards.completedOrders?.prevValue ?? 0,
            diff: summaryCards.completedOrders?.diff ?? 0,
            percent: summaryCards.completedOrders?.percent ?? 0,
          },
          aov: {
            value: summaryCards.aov?.value ?? 0,
            prevValue: summaryCards.aov?.prevValue ?? 0,
          },
          deliverySuccessRate: {
            value: summaryCards.deliverySuccessRate?.value ?? 0,
            deliveredCount: summaryCards.deliverySuccessRate?.deliveredCount ?? 0,
            failedCount: summaryCards.deliverySuccessRate?.failedCount ?? 0,
          },
          cogs: {
            value: profitSummary?.cogs?.value ?? 0,
            prevValue: profitSummary?.cogs?.prevValue ?? 0,
            status: profitSummary?.cogs?.status || "unrecorded",
          },
          grossProfit: {
            value: profitSummary?.grossProfit?.value ?? null,
            trackedValue: profitSummary?.grossProfit?.trackedValue ?? null,
            coverageStatus: profitSummary?.grossProfit?.coverageStatus || "zero",
          },
          grossMargin: {
            value: profitSummary?.grossMargin?.value ?? null,
            trackedValue: profitSummary?.grossMargin?.trackedValue ?? null,
            coverageStatus: profitSummary?.grossMargin?.coverageStatus || "zero",
          },
          costCoverage: {
            ratio: profitSummary?.costCoverage?.ratio ?? 0,
            coverageStatus: profitSummary?.costCoverage?.coverageStatus || "zero",
            warning: profitSummary?.costCoverage?.warning || null,
          },
        }
      : null,
  };
}

/**
 * 2. Order Operational
 * Tái sử dụng: Order model + buildSlaStages()
 */
async function getOrderOperationalData() {
  if (!isDatabaseConnected()) {
    return {
      data_available: false,
      data: null,
      note: "Cơ sở dữ liệu chưa kết nối.",
    };
  }

  const now = new Date();
  const slaStages = buildSlaStages(now);

  const [aggregateResults, pendingPaymentCount] = await Promise.all([
    Order.aggregate([
      ...slaStages,
      {
        $facet: {
          statusCounts: [
            { $group: { _id: "$Display_status", count: { $sum: 1 } } },
          ],
          overdueCount: [
            { $match: { Is_overdue: true } },
            { $count: "count" },
          ],
          sampleOverdueOrders: [
            { $match: { Is_overdue: true } },
            { $sort: { Created_at: 1 } },
            { $limit: MAX_SAMPLE_ITEMS },
            {
              $project: {
                _id: 0,
                Order_id: 1,
                Display_status: 1,
                Sla_stage: 1,
                Sla_deadline: 1,
                Created_at: 1,
              },
            },
          ],
          samplePendingConfirmationOrders: [
            { $match: { Display_status: "pending_confirmation" } },
            { $sort: { Created_at: 1 } },
            { $limit: MAX_SAMPLE_ITEMS },
            {
              $project: {
                _id: 0,
                Order_id: 1,
                Display_status: 1,
                Created_at: 1,
              },
            },
          ],
        },
      },
    ]).catch(() => []),
    Order.countDocuments({ Status: "pending_payment" }).catch(() => 0),
  ]);

  const facet = aggregateResults?.[0] || {};
  const statusCountsMap = {};
  (facet.statusCounts || []).forEach((item) => {
    statusCountsMap[item._id] = item.count;
  });

  const overdueCount = facet.overdueCount?.[0]?.count || 0;
  const pendingConfirmation = statusCountsMap["pending_confirmation"] || 0;
  const processing = statusCountsMap["processing"] || 0;
  const shipping = statusCountsMap["shipping"] || 0;
  const completed = statusCountsMap["completed"] || 0;
  const cancelled = statusCountsMap["cancelled"] || 0;
  const returning = statusCountsMap["returning"] || 0;

  const totalOrders =
    pendingConfirmation +
    processing +
    shipping +
    completed +
    cancelled +
    returning +
    pendingPaymentCount;

  return {
    data_available: true,
    data: {
      totalOrders,
      counts: {
        pending_confirmation: pendingConfirmation,
        processing,
        shipping,
        completed,
        cancelled,
        returning,
        pending_payment: pendingPaymentCount,
        overdue: overdueCount,
      },
      sampleOverdueOrders: facet.sampleOverdueOrders || [],
      samplePendingConfirmationOrders: facet.samplePendingConfirmationOrders || [],
      slaThresholds: {
        confirmTimeoutHours: 2,
        handoverTimeoutHours: 24,
      },
    },
  };
}

/**
 * 3. Return Issue
 * Tái sử dụng: Return_order model
 * Lưu ý bảo mật: Staff không nhận trường Refund_amount
 */
async function getReturnIssueData(role = "Staff") {
  if (!isDatabaseConnected()) {
    return {
      data_available: false,
      data: null,
      note: "Cơ sở dữ liệu chưa kết nối.",
    };
  }

  const [pendingCount, receivedCount, approvedCount, sampleReturns] = await Promise.all([
    Return_order.countDocuments({ Status: "pending" }).catch(() => 0),
    Return_order.countDocuments({ Status: "received" }).catch(() => 0),
    Return_order.countDocuments({ Status: "approved" }).catch(() => 0),
    Return_order.find({ Status: { $in: ["pending", "approved", "received"] } })
      .select("-_id Return_order_id Order_id Status Reason_type Refund_amount Created_at")
      .sort({ Created_at: -1 })
      .limit(MAX_SAMPLE_ITEMS)
      .lean()
      .catch(() => []),
  ]);

  const totalPendingAction = pendingCount + approvedCount + receivedCount;

  return {
    data_available: true,
    data: {
      pendingApprovalCount: pendingCount,
      awaitingGoodsCount: approvedCount,
      receivedInspectionCount: receivedCount,
      totalPendingAction,
      sampleReturns: (sampleReturns || []).map((r) => {
        const item = {
          Return_order_id: r.Return_order_id,
          Order_id: r.Order_id,
          Status: r.Status,
          Reason_type: r.Reason_type,
          Created_at: r.Created_at,
        };
        // Chỉ Manager mới thấy số tiền hoàn trả Refund_amount
        if (role === "Manager") {
          item.Refund_amount = r.Refund_amount || 0;
        }
        return item;
      }),
    },
  };
}

/**
 * 4. Review Moderation
 * Tái sử dụng: Review model
 */
async function getReviewModerationData() {
  if (!isDatabaseConnected()) {
    return {
      data_available: false,
      data: null,
      note: "Cơ sở dữ liệu chưa kết nối.",
    };
  }

  const [pendingCount, negativeCount, unrepliedCount, samplePending, sampleNegative] = await Promise.all([
    Review.countDocuments({ Moderation_status: "pending" }).catch(() => 0),
    Review.countDocuments({ Rating: { $lte: 2 } }).catch(() => 0),
    Review.countDocuments({ Reply_status: { $ne: "replied" }, Moderation_status: "approved" }).catch(() => 0),
    Review.find({ Moderation_status: "pending" })
      .select("-_id Review_id Rating Comment Created_at")
      .sort({ Created_at: -1 })
      .limit(MAX_SAMPLE_ITEMS)
      .lean()
      .catch(() => []),
    Review.find({ Rating: { $lte: 2 } })
      .select("-_id Review_id Rating Comment Moderation_status Reply_status Created_at")
      .sort({ Created_at: -1 })
      .limit(MAX_SAMPLE_ITEMS)
      .lean()
      .catch(() => []),
  ]);

  return {
    data_available: true,
    data: {
      pendingModerationCount: pendingCount,
      negativeReviewCount: negativeCount,
      unrepliedApprovedCount: unrepliedCount,
      samplePendingReviews: (samplePending || []).map((r) => ({
        Review_id: r.Review_id,
        Rating: r.Rating,
        Comment: r.Comment ? String(r.Comment).slice(0, 100) : "",
        Created_at: r.Created_at,
      })),
      sampleNegativeReviews: (sampleNegative || []).map((r) => ({
        Review_id: r.Review_id,
        Rating: r.Rating,
        Comment: r.Comment ? String(r.Comment).slice(0, 100) : "",
        Moderation_status: r.Moderation_status,
        Reply_status: r.Reply_status,
        Created_at: r.Created_at,
      })),
    },
  };
}

/**
 * 5. General Policy
 * Không truy vấn MongoDB – Trả về kiến thức quy trình chuẩn của hệ thống VISTA.
 */
function getGeneralPolicyData(role) {
  return {
    data_available: true,
    data: {
      orderSlaPolicy: {
        confirmDeadlineHours: 2,
        confirmDeadlineDescription: "Tối đa 2 giờ kể từ khi khách đặt hàng đối với đơn COD hoặc đơn chuyển khoản đã thanh toán",
        handoverDeadlineHours: 24,
        handoverDeadlineDescription: "Tối đa 24 giờ kể từ khi đơn hàng được xác nhận sang bưu tá vận chuyển",
        overdueConsequence: "Đơn vượt quá các mốc trên sẽ bị đánh dấu quá hạn xử lý (Is_overdue = true)",
      },
      returnPolicy: {
        windowDays: 7,
        windowDescription: "Khách hàng được yêu cầu đổi trả trong vòng 7 ngày kể từ khi nhận hàng",
        validReasons: [
          "Sản phẩm lỗi do nhà sản xuất",
          "Giao sai sản phẩm / sai thông số kỹ thuật",
          "Thiếu phụ kiện theo niêm yết",
          "Hàng bị hư hỏng trong quá trình vận chuyển",
        ],
        steps: [
          "1. Tiếp nhận và duyệt yêu cầu đổi trả (Status: pending -> approved)",
          "2. Hướng dẫn khách gửi hàng hoàn về kho VISTA",
          "3. Kiểm định tình trạng hàng hoá thực tế tại kho",
          "4. Quyết định hoàn tiền (completed/refunded) hoặc từ chối nếu vi phạm điều kiện",
        ],
      },
      reviewPolicy: {
        moderationRule: "Đánh giá của khách hàng phải được Staff duyệt (approved) trước khi hiển thị công khai trên website",
        priorityRule: "Ưu tiên phản hồi nhanh các đánh giá 1-2 sao để hỗ trợ xử lý khiếu nại khách hàng",
        autoReplyNote: "Tính năng AI gợi ý phản hồi chỉ tạo bản nháp (draft); Staff phải kiểm tra trước khi gửi chính thức",
      },
      rolePermissions: {
        currentRole: role,
        description: role === "Manager"
          ? "Manager: Có toàn quyền quản trị, theo dõi Dashboard kinh doanh, giá vốn, lợi nhuận gộp, quản lý nhân sự, danh mục và voucher."
          : "Staff: Quản lý và xử lý đơn hàng, duyệt đổi trả, kiểm duyệt đánh giá, tra cứu sản phẩm và voucher. Không có quyền truy cập dữ liệu tài chính.",
      },
    },
  };
}

/**
 * 6. Build Context
 * Điều phối gọi hàm lấy dữ liệu tương ứng và đóng gói chuẩn cho AI.
 */
async function buildContext(intent, role) {
  const timestamp = new Date().toISOString();

  try {
    if (intent === "financial_kpi") {
      if (role !== "Manager") {
        return {
          intent,
          role,
          data_available: false,
          data_timestamp: timestamp,
          data: null,
          error: "ROLE_DENIED",
        };
      }
      const res = await (exports.getFinancialKpiData || getFinancialKpiData)(role);
      return {
        intent,
        role,
        data_available: res.data_available,
        data_timestamp: timestamp,
        data: res.data,
      };
    }

    if (intent === "order_operational") {
      const res = await (exports.getOrderOperationalData || getOrderOperationalData)();
      return {
        intent,
        role,
        data_available: res.data_available,
        data_timestamp: timestamp,
        data: res.data,
      };
    }

    if (intent === "return_issue") {
      const res = await (exports.getReturnIssueData || getReturnIssueData)(role);
      return {
        intent,
        role,
        data_available: res.data_available,
        data_timestamp: timestamp,
        data: res.data,
      };
    }

    if (intent === "review_moderation") {
      const res = await (exports.getReviewModerationData || getReviewModerationData)();
      return {
        intent,
        role,
        data_available: res.data_available,
        data_timestamp: timestamp,
        data: res.data,
      };
    }

    if (intent === "general_policy") {
      const res = getGeneralPolicyData(role);
      return {
        intent,
        role,
        data_available: res.data_available,
        data_timestamp: timestamp,
        data: res.data,
      };
    }

    // unsupported
    return {
      intent: "unsupported",
      role,
      data_available: false,
      data_timestamp: timestamp,
      data: null,
    };
  } catch (err) {
    console.error(`[Assistant] Data retrieval error for ${intent}:`, err.message);
    return {
      intent,
      role,
      data_available: false,
      data_timestamp: timestamp,
      data: null,
      error_note: "Nguồn dữ liệu tạm thời không khả dụng.",
    };
  }
}

// ─────────────────────────────────────────────────────────
// HELPER: TẠO RESPONSE THỐNG NHẤT
// ─────────────────────────────────────────────────────────

function makeSuccessResponse(res, { message, intent, status, context, debugNote }) {
  const payload = { message, intent, status, context };
  if (debugNote && process.env.NODE_ENV !== "production") {
    payload.debug = debugNote;
  }
  return res.json({ success: true, data: payload });
}

function makeDeniedResponse(res, { message, intent }) {
  return res.json({
    success: false,
    data: { message, intent, status: "role_denied" },
  });
}

function makeUnsupportedResponse(res, intent, role) {
  return res.json({
    success: true,
    data: {
      message:
        "Câu hỏi nằm ngoài phạm vi hỗ trợ hiện tại của VISTA AI Assistant. Bạn có thể hỏi về đơn hàng, đổi trả, đánh giá hoặc các quy trình nghiệp vụ.",
      intent,
      status: "unsupported",
      context: {
        intent: "unsupported",
        role,
        data_available: false,
        data_timestamp: new Date().toISOString(),
        data: null,
      },
    },
  });
}

// ─────────────────────────────────────────────────────────
// CONTROLLER CHÍNH
// ─────────────────────────────────────────────────────────

/**
 * POST /api/admin/assistant/chat
 *
 * Giai đoạn 2: Nhận diện intent, kiểm tra RBAC, truy xuất dữ liệu nghiệp vụ
 * và xây dựng Context có cấu trúc chuẩn.
 */
exports.chat = async (req, res) => {
  try {
    // ── 1. LẤY ROLE TỪ REQ.USER (đã qua middleware xác thực) ──────────────
    // Tuyệt đối không lấy Role từ req.body hoặc history.
    const userRole = req.user?.Role;
    const userId = req.user?.User_id;

    if (!userRole || (userRole !== "Manager" && userRole !== "Staff")) {
      return res.status(403).json({
        success: false,
        message: "Vai trò tài khoản không hợp lệ để sử dụng tính năng này.",
      });
    }

    // ── 2. VALIDATE INPUT ───────────────────────────────────────────────────
    const { message, history } = req.body;

    const validationError = validateMessage(message);
    if (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError,
      });
    }

    const cleanMessage = message.trim();
    const cleanHistory = sanitiseHistory(history);

    // ── 3. PHÂN LOẠI INTENT (Backend Rules) ────────────────────────────────
    const intent = detectIntent(cleanMessage);

    // ── 4. KIỂM TRA QUYỀN – TRƯỚC MỌI BƯỚC LẤY DỮ LIỆU ──────────────────
    // Nếu Staff hỏi financial_kpi -> Từ chối ngay, không gọi service tài chính
    if (!isIntentAllowed(userRole, intent)) {
      console.log(
        `[Assistant] RBAC DENIED – User: ${userId}, Role: ${userRole}, Intent: ${intent}`
      );
      return makeDeniedResponse(res, {
        message:
          "Bạn không có quyền truy cập thông tin tài chính. Thông tin doanh thu, giá vốn và lợi nhuận chỉ dành cho Manager.",
        intent,
      });
    }

    // ── 5. XỬ LÝ THEO INTENT ───────────────────────────────────────────────
    if (intent === "unsupported") {
      return makeUnsupportedResponse(res, intent, userRole);
    }

    // ── 6. TRUY XUẤT DỮ LIỆU THỰC & ĐÓNG GÓI CONTEXT ───────────────────────
    const context = await buildContext(intent, userRole);

    // ── 7. SINH CÂU TRẢ LỜI TỰ NHIÊN BẰNG GROQ AI (Grounding) ─────────────
    let aiReply = "";
    try {
      aiReply = await assistantAiService.generateAnswer(cleanMessage, context, cleanHistory);
    } catch (aiError) {
      console.error("[Assistant] AI generation error:", aiError.message);
      if (aiError.status === 429 || aiError.code === "RATE_LIMIT") {
        aiReply = "Hệ thống AI đang tạm thời bận do vượt quá giới hạn yêu cầu (HTTP 429). Dữ liệu đã được trích xuất an toàn bên dưới; vui lòng gửi lại câu hỏi sau giây lát.";
      } else if (aiError.name === "TimeoutError" || aiError.name === "AbortError") {
        aiReply = "Thời gian phản hồi từ dịch vụ AI vượt quá 15 giây (timeout). Dữ liệu nghiệp vụ đã được trích xuất an toàn bên dưới.";
      } else if (aiError.code === "MISSING_API_KEY" || aiError.message?.includes("GROQ_API_KEY")) {
        aiReply = "Dịch vụ AI chưa được cấu hình GROQ_API_KEY. Dữ liệu ngữ cảnh nghiệp vụ đã được chuẩn bị sẵn sàng bên dưới.";
      } else {
        aiReply = "Dịch vụ AI tạm thời không khả dụng. Dữ liệu ngữ cảnh nghiệp vụ đã được chuẩn bị an toàn bên dưới.";
      }
    }

    return makeSuccessResponse(res, {
      message: aiReply || "Đã trích xuất dữ liệu thành công cho context.",
      intent,
      status: "answered",
      context,
      debugNote: `Role: ${userRole}, History items: ${cleanHistory.length}`,
    });
  } catch (error) {
    console.error("[Assistant] Unexpected error:", error);
    return res.status(500).json({
      success: false,
      data: {
        message: "Đã xảy ra lỗi hệ thống. Vui lòng thử lại sau.",
        intent: null,
        status: "error",
      },
    });
  }
};

// Xuất các hàm hỗ trợ để kiểm thử độc lập
exports.detectIntent = detectIntent;
exports.isIntentAllowed = isIntentAllowed;
exports.isDatabaseConnected = isDatabaseConnected;
exports.getFinancialKpiData = getFinancialKpiData;
exports.getOrderOperationalData = getOrderOperationalData;
exports.getReturnIssueData = getReturnIssueData;
exports.getReviewModerationData = getReviewModerationData;
exports.getGeneralPolicyData = getGeneralPolicyData;
exports.buildContext = buildContext;
exports.INTENT_RULES = INTENT_RULES;
