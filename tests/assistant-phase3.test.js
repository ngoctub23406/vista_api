/**
 * GIAI ĐOẠN 3 – Test: Groq Integration & AI Response Generation
 * Dùng node:test built-in.
 * Sử dụng mock/stub Groq để chạy offline, không tiêu hao quota và không phụ thuộc API thật.
 *
 * Chạy: node --test tests/assistant-phase3.test.js
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const assistantAiService = require("../services/assistant-ai.service");
const assistantController = require("../controllers/admin/assistant.controller");

// Helper mock res
function mockRes() {
  return {
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
}

// Helper mock req
function mockReq({ role, body = {} }) {
  return {
    user: { User_id: `TEST_${role}`, Role: role },
    body,
  };
}

async function callChat(role, body) {
  const req = mockReq({ role, body });
  const res = mockRes();
  await assistantController.chat(req, res);
  return res;
}

// =============================================================================
// TEST GROUP 1: GROQ SERVICE UNIT TESTS (MOCK FETCH)
// =============================================================================

test("1.1 – Groq trả lời thành công: Trả về câu trả lời tự nhiên", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "mock_test_key";

  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: "Doanh thu thuần trong 30 ngày qua đạt 120.000.000đ từ 95 đơn hàng hoàn tất.",
          },
        },
      ],
    }),
  });

  try {
    const context = {
      intent: "financial_kpi",
      role: "Manager",
      data_available: true,
      data_timestamp: new Date().toISOString(),
      data: { netRevenue: { value: 120000000 }, completedOrders: { value: 95 } },
    };

    const answer = await assistantAiService.generateAnswer("Doanh thu tháng này?", context);
    assert.ok(answer.includes("120.000.000đ"));
    assert.ok(answer.includes("95 đơn"));
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
});

test("1.2 – Loại bỏ thẻ <think>...</think> khỏi câu trả lời", () => {
  const rawWithThink = "<think>Phân tích dữ liệu doanh thu...</think>Doanh thu tháng này là 50 triệu đồng.";
  const cleaned = assistantAiService.cleanAiResponse(rawWithThink);
  assert.equal(cleaned, "Doanh thu tháng này là 50 triệu đồng.");
  assert.equal(cleaned.includes("<think>"), false);
});

test("1.3 – Groq trả HTTP 429 (Rate Limit) → Báo lỗi RATE_LIMIT hoặc fallback", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "mock_test_key";

  // Mock fetch luôn trả về 429
  global.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => "rate limit exceeded",
  });

  try {
    await assert.rejects(
      async () => {
        await assistantAiService.generateAnswer("Test rate limit", { intent: "order_operational" });
      },
      (err) => {
        assert.equal(err.status, 429);
        assert.equal(err.code, "RATE_LIMIT");
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
});

test("1.4 – Groq Timeout (15s) → Báo lỗi TimeoutError", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "mock_test_key";

  global.fetch = async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  };

  try {
    await assert.rejects(
      async () => {
        await assistantAiService.generateAnswer("Test timeout", { intent: "order_operational" });
      },
      (err) => {
        assert.equal(err.name, "TimeoutError");
        return true;
      }
    );
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
});

test("1.5 – Không có GROQ_API_KEY → Ném lỗi MISSING_API_KEY", async () => {
  const originalKey = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;

  try {
    await assert.rejects(
      async () => {
        await assistantAiService.generateAnswer("Test no key", { intent: "order_operational" });
      },
      (err) => {
        assert.equal(err.code, "MISSING_API_KEY");
        return true;
      }
    );
  } finally {
    process.env.GROQ_API_KEY = originalKey;
  }
});

test("1.6 – Model đầu tiên bị lỗi (404/400) → Tự động fallback sang model tiếp theo", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "mock_test_key";

  let callCount = 0;
  global.fetch = async (_url, options) => {
    callCount++;
    const body = JSON.parse(options.body);

    if (body.model === "llama-3.3-70b-versatile") {
      // Model 1 lỗi 404
      return { ok: false, status: 404, text: async () => "Model deprecated" };
    }
    // Model 2 thành công
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Phản hồi từ model fallback." } }],
      }),
    };
  };

  try {
    const res = await assistantAiService.generateAnswer("Test fallback", { intent: "order_operational" });
    assert.equal(res, "Phản hồi từ model fallback.");
    assert.equal(callCount, 2, "Phải gọi 2 lần: lần 1 thất bại, lần 2 thành công");
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
});

test("1.7 – Model trả về content rỗng → Tiếp tục fallback sang model khác", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "mock_test_key";

  let callCount = 0;
  global.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      // Model 1 trả về rỗng
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "   " } }] }),
      };
    }
    // Model 2 trả về có nội dung
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Dữ liệu hợp lệ từ model 2." } }],
      }),
    };
  };

  try {
    const res = await assistantAiService.generateAnswer("Test empty content", { intent: "order_operational" });
    assert.equal(res, "Dữ liệu hợp lệ từ model 2.");
    assert.equal(callCount, 2);
  } finally {
    global.fetch = originalFetch;
    process.env.GROQ_API_KEY = originalKey;
  }
});

// =============================================================================
// TEST GROUP 2: SYSTEM PROMPT & GROUNDING
// =============================================================================

test("2.1 – System Prompt bắt buộc trả lời tiếng Việt và cấm bịa số liệu", () => {
  const context = {
    role: "Manager",
    intent: "financial_kpi",
    data_available: true,
    data: { netRevenue: { value: 100000000 } },
  };

  const prompt = assistantAiService.buildSystemPrompt(context);
  assert.ok(prompt.includes("TIẾNG VIỆT"), "Prompt yêu cầu tiếng Việt");
  assert.ok(prompt.includes("READ-ONLY"), "Prompt khẳng định chỉ đọc");
  assert.ok(prompt.includes("TUYỆT ĐỐI KHÔNG tự bịa"), "Prompt cấm bịa số liệu");
  assert.ok(prompt.includes("PROMPT INJECTION"), "Prompt có chỉ thị chống bẻ khóa");
  assert.ok(prompt.includes("100000000"), "Dữ liệu context được gắn vào prompt");
});

test("2.2 – System Prompt khi data_available = false thông báo rõ ràng", () => {
  const context = {
    role: "Staff",
    intent: "order_operational",
    data_available: false,
    data: null,
  };

  const prompt = assistantAiService.buildSystemPrompt(context);
  assert.ok(prompt.includes("Dữ liệu khả dụng: KHÔNG CÓ"));
  assert.ok(prompt.includes("data_available là false, bạn phải thông báo rõ ràng"));
});

// =============================================================================
// TEST GROUP 3: RBAC BẢO MẬT – STAFF KHÔNG GỌI GROQ CHO TÀI CHÍNH
// =============================================================================

test("3.1 – [RBAC BẮT BUỘC] Staff hỏi tài chính → Bị chặn trước khi gọi Groq (groqCalls = 0)", async () => {
  let groqCalls = 0;
  const originalGenerate = assistantAiService.generateAnswer;
  assistantAiService.generateAnswer = async () => {
    groqCalls++;
    return "Phản hồi AI";
  };

  try {
    const res = await callChat("Staff", { message: "Cho tôi biết doanh thu và lợi nhuận tháng này?" });

    assert.equal(res._statusCode, 200);
    assert.equal(res._body.success, false);
    assert.equal(res._body.data.status, "role_denied");
    assert.equal(res._body.data.intent, "financial_kpi");

    // Khẳng định mấu chốt: Groq tuyệt đối không được gọi!
    assert.equal(groqCalls, 0, "generateAnswer TUYỆT ĐỐI không được gọi khi Staff hỏi tài chính");
  } finally {
    assistantAiService.generateAnswer = originalGenerate;
  }
});

test("3.2 – [RBAC BẮT BUỘC] Staff hỏi đổi trả → Context TUYỆT ĐỐI không chứa Refund_amount", async () => {
  const originalGenerate = assistantAiService.generateAnswer;
  let receivedContext = null;

  assistantAiService.generateAnswer = async (_msg, ctx) => {
    receivedContext = ctx;
    return "Danh sách đổi trả đang chờ xử lý.";
  };

  const originalGetReturnData = assistantController.getReturnIssueData;
  assistantController.getReturnIssueData = async (role) => {
    const data = {
      pendingApprovalCount: 2,
      totalPendingAction: 2,
      sampleReturns: [
        {
          Return_order_id: "RET_001",
          Order_id: "ORD_001",
          Status: "pending",
          Reason_type: "Lỗi sản phẩm",
        },
      ],
    };
    if (role === "Manager") {
      data.sampleReturns[0].Refund_amount = 500000;
    }
    return { data_available: true, data };
  };

  try {
    const res = await callChat("Staff", { message: "Có yêu cầu đổi trả nào đang chờ?" });

    assert.equal(res._body.success, true);
    assert.equal(res._body.data.intent, "return_issue");

    // Kiểm tra context gửi tới Groq
    assert.ok(receivedContext);
    assert.equal(receivedContext.role, "Staff");
    if (receivedContext.data && receivedContext.data.sampleReturns) {
      for (const item of receivedContext.data.sampleReturns) {
        assert.equal(item.Refund_amount, undefined, "Staff tuyệt đối không có trường Refund_amount");
      }
    }
  } finally {
    assistantAiService.generateAnswer = originalGenerate;
    assistantController.getReturnIssueData = originalGetReturnData;
  }
});

test("3.3 – Manager hỏi đổi trả → Context CÓ trường Refund_amount", async () => {
  const originalGenerate = assistantAiService.generateAnswer;
  let receivedContext = null;

  assistantAiService.generateAnswer = async (_msg, ctx) => {
    receivedContext = ctx;
    return "Danh sách đổi trả.";
  };

  const originalGetReturnData = assistantController.getReturnIssueData;
  assistantController.getReturnIssueData = async (role) => {
    const data = {
      pendingApprovalCount: 2,
      totalPendingAction: 2,
      sampleReturns: [
        {
          Return_order_id: "RET_001",
          Order_id: "ORD_001",
          Status: "pending",
          Reason_type: "Lỗi sản phẩm",
        },
      ],
    };
    if (role === "Manager") {
      data.sampleReturns[0].Refund_amount = 500000;
    }
    return { data_available: true, data };
  };

  try {
    const res = await callChat("Manager", { message: "Có yêu cầu đổi trả nào đang chờ?" });
    assert.equal(res._body.success, true);
    assert.equal(receivedContext.role, "Manager");
    assert.equal(receivedContext.data.sampleReturns[0].Refund_amount, 500000, "Manager phải có trường Refund_amount");
  } finally {
    assistantAiService.generateAnswer = originalGenerate;
    assistantController.getReturnIssueData = originalGetReturnData;
  }
});

test("3.4 – Manager hỏi doanh thu → Được gọi Groq với context tài chính đầy đủ", async () => {
  let groqCalls = 0;
  let passedContext = null;

  const originalGenerate = assistantAiService.generateAnswer;
  assistantAiService.generateAnswer = async (_msg, ctx) => {
    groqCalls++;
    passedContext = ctx;
    return "Doanh thu tháng này đạt mức tăng trưởng tốt.";
  };

  try {
    const res = await callChat("Manager", { message: "Doanh thu tháng này thế nào?" });

    assert.equal(res._statusCode, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.data.status, "answered");
    assert.equal(res._body.data.message, "Doanh thu tháng này đạt mức tăng trưởng tốt.");

    assert.equal(groqCalls, 1, "Manager hỏi tài chính thì Groq phải được gọi");
    assert.ok(passedContext);
    assert.equal(passedContext.role, "Manager");
    assert.equal(passedContext.intent, "financial_kpi");
  } finally {
    assistantAiService.generateAnswer = originalGenerate;
  }
});

test("3.5 – Staff hỏi đơn hàng → Được gọi Groq với context vận hành (không tài chính)", async () => {
  let groqCalls = 0;
  let passedContext = null;

  const originalGenerate = assistantAiService.generateAnswer;
  assistantAiService.generateAnswer = async (_msg, ctx) => {
    groqCalls++;
    passedContext = ctx;
    return "Hiện có 3 đơn hàng chờ xác nhận và 1 đơn quá hạn SLA.";
  };

  try {
    const res = await callChat("Staff", { message: "Có bao nhiêu đơn hàng chờ xác nhận?" });

    assert.equal(res._statusCode, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.data.message, "Hiện có 3 đơn hàng chờ xác nhận và 1 đơn quá hạn SLA.");

    assert.equal(groqCalls, 1);
    assert.equal(passedContext.role, "Staff");
    assert.equal(passedContext.intent, "order_operational");
    assert.equal(passedContext.data?.netRevenue, undefined);
    assert.equal(passedContext.data?.cogs, undefined);
  } finally {
    assistantAiService.generateAnswer = originalGenerate;
  }
});
