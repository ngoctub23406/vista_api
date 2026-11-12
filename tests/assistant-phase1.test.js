/**
 * GIAI ĐOẠN 1 – Test: Assistant Controller (Intent & RBAC)
 * Dùng node:test built-in – không cần cài thêm package.
 *
 * Chạy: node --test tests/assistant-phase1.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

// ─── Import module cần test ───────────────────────────────────────────────────
const assistantController = require("../controllers/admin/assistant.controller");
const authMiddleware = require("../middleware/auth.middleware");

// ─── Helper: mock res object ──────────────────────────────────────────────────
function mockRes() {
  const res = {
    _statusCode: 200,
    _body: null,
    status(code) {
      this._statusCode = code;
      return this;
    },
    json(payload) {
      this._body = payload;
      return this;
    },
  };
  return res;
}

// ─── Helper: build req object ─────────────────────────────────────────────────
function mockReq({ role, body = {} }) {
  return {
    user: { User_id: `TEST_${role}`, Role: role },
    body,
  };
}

// ─── Hàm wrapper để gọi controller và trả về kết quả ─────────────────────────
async function callChat(role, body) {
  const req = mockReq({ role, body });
  const res = mockRes();
  await assistantController.chat(req, res);
  return res;
}

// =============================================================================
// TEST GROUP 1: VALIDATION INPUT
// =============================================================================

test("1.1 – Câu hỏi rỗng (empty string) phải trả 400", async () => {
  const res = await callChat("Manager", { message: "" });
  assert.equal(res._statusCode, 400);
  assert.equal(res._body.success, false);
  assert.ok(
    res._body.message,
    "Phải có message mô tả lỗi"
  );
});

test("1.2 – Không có trường message phải trả 400", async () => {
  const res = await callChat("Manager", {});
  assert.equal(res._statusCode, 400);
  assert.equal(res._body.success, false);
});

test("1.3 – message là số (không phải string) phải trả 400", async () => {
  const res = await callChat("Manager", { message: 12345 });
  assert.equal(res._statusCode, 400);
  assert.equal(res._body.success, false);
});

test("1.4 – message quá dài (>1000 ký tự) phải trả 400", async () => {
  const longMessage = "a".repeat(1001);
  const res = await callChat("Manager", { message: longMessage });
  assert.equal(res._statusCode, 400);
  assert.equal(res._body.success, false);
});

test("1.5 – message chỉ là khoảng trắng phải trả 400", async () => {
  const res = await callChat("Manager", { message: "   " });
  assert.equal(res._statusCode, 400);
  assert.equal(res._body.success, false);
});

// =============================================================================
// TEST GROUP 2: PHÂN LOẠI INTENT
// =============================================================================

test("2.1 – Câu hỏi về doanh thu → intent: financial_kpi", async () => {
  const res = await callChat("Manager", { message: "Doanh thu tháng này là bao nhiêu?" });
  assert.equal(res._statusCode, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.data.intent, "financial_kpi");
  assert.equal(res._body.data.status, "answered");
});

test("2.2 – Câu hỏi về lợi nhuận → intent: financial_kpi", async () => {
  const res = await callChat("Manager", { message: "Gross profit và gross margin kỳ này?" });
  assert.equal(res._body.data.intent, "financial_kpi");
});

test("2.3 – Câu hỏi về giá vốn → intent: financial_kpi", async () => {
  const res = await callChat("Manager", { message: "Giá vốn hàng bán hiện tại thế nào?" });
  assert.equal(res._body.data.intent, "financial_kpi");
});

test("2.4 – Câu hỏi về đơn hàng → intent: order_operational", async () => {
  const res = await callChat("Manager", { message: "Có bao nhiêu đơn hàng đang chờ xác nhận?" });
  assert.equal(res._body.data.intent, "order_operational");
});

test("2.5 – Câu hỏi về đơn quá hạn SLA → intent: order_operational", async () => {
  const res = await callChat("Staff", { message: "Những đơn nào đã quá hạn SLA?" });
  assert.equal(res._body.data.intent, "order_operational");
  assert.equal(res._body.data.status, "answered");
});

test("2.6 – Câu hỏi về đổi trả → intent: return_issue", async () => {
  const res = await callChat("Staff", { message: "Có yêu cầu đổi trả nào cần xử lý không?" });
  assert.equal(res._body.data.intent, "return_issue");
  assert.equal(res._body.data.status, "answered");
});

test("2.7 – Câu hỏi về đánh giá → intent: review_moderation", async () => {
  const res = await callChat("Staff", { message: "Những đánh giá nào đang chờ kiểm duyệt?" });
  assert.equal(res._body.data.intent, "review_moderation");
  assert.equal(res._body.data.status, "answered");
});

test("2.8 – Câu hỏi về đánh giá tiêu cực → intent: review_moderation", async () => {
  const res = await callChat("Staff", { message: "Có đánh giá 1 sao nào chưa phản hồi?" });
  assert.equal(res._body.data.intent, "review_moderation");
});

test("2.9 – Câu hỏi về quy trình nghiệp vụ → intent: general_policy", async () => {
  const res = await callChat("Staff", { message: "Hướng dẫn quy trình xử lý đổi trả" });
  assert.equal(res._body.data.intent, "general_policy");
  assert.equal(res._body.data.status, "answered");
});

test("2.10 – Câu hỏi không liên quan → intent: unsupported", async () => {
  const res = await callChat("Manager", { message: "Hôm nay thời tiết thế nào?" });
  assert.equal(res._statusCode, 200);
  assert.equal(res._body.data.intent, "unsupported");
  assert.equal(res._body.data.status, "unsupported");
});

// =============================================================================
// TEST GROUP 3: RBAC – BẢO MẬT QUAN TRỌNG NHẤT
// =============================================================================

test("3.1 – [BẢO MẬT] Staff hỏi doanh thu → role_denied, không được tiếp tục", async () => {
  const res = await callChat("Staff", { message: "Doanh thu tháng này là bao nhiêu?" });
  assert.equal(res._statusCode, 200, "HTTP status phải là 200 (không phải lỗi server)");
  assert.equal(res._body.success, false, "success phải là false khi bị từ chối");
  assert.equal(res._body.data.status, "role_denied", "status phải là role_denied");
  assert.equal(res._body.data.intent, "financial_kpi", "intent phải là financial_kpi");
  assert.ok(
    res._body.data.message.includes("tài chính") ||
    res._body.data.message.includes("Manager"),
    "Message phải nêu rõ lý do từ chối"
  );
});

test("3.2 – [BẢO MẬT] Staff hỏi giá vốn → role_denied", async () => {
  const res = await callChat("Staff", { message: "Giá vốn hiện tại là bao nhiêu?" });
  assert.equal(res._body.data.status, "role_denied");
  assert.equal(res._body.data.intent, "financial_kpi");
});

test("3.3 – [BẢO MẬT] Staff hỏi gross profit → role_denied", async () => {
  const res = await callChat("Staff", { message: "Gross profit kỳ này?" });
  assert.equal(res._body.data.status, "role_denied");
  assert.equal(res._body.data.intent, "financial_kpi");
});

test("3.4 – [BẢO MẬT] Staff hỏi margin → role_denied", async () => {
  const res = await callChat("Staff", { message: "Gross margin là bao nhiêu phần trăm?" });
  assert.equal(res._body.data.status, "role_denied");
  assert.equal(res._body.data.intent, "financial_kpi");
});

test("3.5 – [BẢO MẬT] Staff hỏi KPI tài chính → role_denied", async () => {
  const res = await callChat("Staff", { message: "Tình hình kinh doanh tháng này thế nào?" });
  assert.equal(res._body.data.status, "role_denied");
  assert.equal(res._body.data.intent, "financial_kpi");
});

test("3.6 – Manager hỏi doanh thu → được phép (answered)", async () => {
  const res = await callChat("Manager", { message: "Doanh thu tháng này là bao nhiêu?" });
  assert.equal(res._body.success, true, "Manager phải được phép");
  assert.equal(res._body.data.intent, "financial_kpi");
  assert.notEqual(res._body.data.status, "role_denied", "Manager không được bị denied");
});

test("3.7 – Manager hỏi giá vốn → được phép (answered)", async () => {
  const res = await callChat("Manager", { message: "Giá vốn COGS tháng này?" });
  assert.equal(res._body.data.status, "answered");
});

test("3.8 – Staff hỏi đơn hàng → được phép (answered)", async () => {
  const res = await callChat("Staff", { message: "Có bao nhiêu đơn hàng đang chờ xử lý?" });
  assert.equal(res._body.success, true, "Staff được phép hỏi đơn hàng");
  assert.equal(res._body.data.status, "answered");
  assert.equal(res._body.data.intent, "order_operational");
});

test("3.9 – Staff hỏi đổi trả → được phép (answered)", async () => {
  const res = await callChat("Staff", { message: "Yêu cầu đổi trả nào cần xử lý?" });
  assert.equal(res._body.success, true);
  assert.equal(res._body.data.intent, "return_issue");
  assert.equal(res._body.data.status, "answered");
});

test("3.10 – Staff hỏi đánh giá → được phép (answered)", async () => {
  const res = await callChat("Staff", { message: "Có đánh giá nào đang chờ kiểm duyệt không?" });
  assert.equal(res._body.success, true);
  assert.equal(res._body.data.intent, "review_moderation");
  assert.equal(res._body.data.status, "answered");
});

// =============================================================================
// TEST GROUP 4: CHỐNG GIẢ MẠO ROLE
// =============================================================================

test("4.1 – Role giả mạo trong body bị bỏ qua – Backend dùng req.user.Role", async () => {
  // Giả lập request: req.user.Role = "Staff" (đã xác thực)
  // nhưng body gửi lên Role = "Manager" (cố tình giả mạo)
  const req = {
    user: { User_id: "STF_FAKE", Role: "Staff" },
    body: {
      message: "Doanh thu tháng này?",
      role: "Manager",          // Cố tình giả mạo
      Role: "Manager",          // Cố tình giả mạo
      userRole: "Manager",      // Cố tình giả mạo
    },
  };
  const res = mockRes();
  await assistantController.chat(req, res);

  // Controller phải dùng req.user.Role = "Staff", không phải Role trong body
  assert.equal(res._body.data.status, "role_denied",
    "Staff giả mạo Manager trong body phải bị từ chối theo req.user.Role");
  assert.equal(res._body.data.intent, "financial_kpi");
});

test("4.2 – req.user không có Role → 403", async () => {
  const req = {
    user: { User_id: "UNKNOWN", Role: undefined },
    body: { message: "Xin chào" },
  };
  const res = mockRes();
  await assistantController.chat(req, res);
  assert.equal(res._statusCode, 403);
  assert.equal(res._body.success, false);
});

test("4.3 – req.user.Role là Customer → 403 (không phải Manager hay Staff)", async () => {
  const req = {
    user: { User_id: "CUST_001", Role: "Customer" },
    body: { message: "Tôi muốn xem doanh thu" },
  };
  const res = mockRes();
  await assistantController.chat(req, res);
  assert.equal(res._statusCode, 403);
  assert.equal(res._body.success, false);
});

// =============================================================================
// TEST GROUP 5: RBAC MIDDLEWARE INTEGRATION CHECK
// (Kiểm tra requireRole logic tương tự cách dashboard-phase2.test.js làm)
// =============================================================================

test("5.1 – requireRole('Manager','Staff') cho phép Manager", () => {
  const middleware = authMiddleware.requireRole("Manager", "Staff");
  let nextCalled = false;
  const res = mockRes();
  middleware({ user: { Role: "Manager" } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, "Manager phải qua được requireRole('Manager','Staff')");
});

test("5.2 – requireRole('Manager','Staff') cho phép Staff", () => {
  const middleware = authMiddleware.requireRole("Manager", "Staff");
  let nextCalled = false;
  const res = mockRes();
  middleware({ user: { Role: "Staff" } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, "Staff phải qua được requireRole('Manager','Staff')");
});

test("5.3 – requireRole('Manager','Staff') chặn Customer → 403", () => {
  const middleware = authMiddleware.requireRole("Manager", "Staff");
  let nextCalled = false;
  const res = mockRes();
  middleware({ user: { Role: "Customer" } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false, "Customer bị chặn tại route level");
  assert.equal(res._statusCode, 403, "HTTP 403 Forbidden");
});

// =============================================================================
// TEST GROUP 6: HISTORY SANITISATION
// =============================================================================

test("6.1 – history hợp lệ được chấp nhận, không phá vỡ flow", async () => {
  const history = [
    { role: "user", content: "Câu hỏi trước" },
    { role: "assistant", content: "Câu trả lời trước" },
  ];
  const res = await callChat("Staff", {
    message: "Có đơn nào quá hạn không?",
    history,
  });
  assert.equal(res._body.success, true);
  assert.equal(res._body.data.intent, "order_operational");
});

test("6.2 – history không phải mảng → bỏ qua, không lỗi", async () => {
  const res = await callChat("Manager", {
    message: "Doanh thu?",
    history: "invalid_string",
  });
  assert.equal(res._body.success, true);
  assert.equal(res._body.data.intent, "financial_kpi");
});

test("6.3 – history chứa item không hợp lệ → chỉ lọc bỏ, không lỗi", async () => {
  const history = [
    { role: "user", content: "Hợp lệ" },
    { role: "ADMIN", content: "Role không hợp lệ" }, // sẽ bị lọc
    null,                                              // sẽ bị lọc
    { role: "assistant", content: "" },               // content rỗng, bị lọc
  ];
  const res = await callChat("Staff", {
    message: "Đơn đổi trả cần xử lý?",
    history,
  });
  assert.equal(res._body.success, true);
  assert.equal(res._body.data.intent, "return_issue");
});
