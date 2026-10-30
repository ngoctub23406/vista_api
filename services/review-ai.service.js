// Dịch vụ AI sinh phản hồi tự động (Auto-reply) cho đánh giá của khách hàng (BR-REV-02)
// AI chỉ gợi ý, không bao giờ tự gửi cho khách.

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
];
const AI_TIMEOUT_MS = 15000;

function buildPrompt({ rating, comment, productName, customerName }) {
  const tone =
    rating >= 4
      ? "Khách hài lòng: cảm ơn chân thành, ghi nhận điểm khách khen."
      : rating === 3
        ? "Khách chưa thật sự hài lòng: cảm ơn, ghi nhận góp ý, mời khách liên hệ cửa hàng để được hỗ trợ."
        : "Khách không hài lòng: xin lỗi chân thành, không đổ lỗi cho khách, mời khách liên hệ cửa hàng để được kiểm tra và hỗ trợ.";

  return `Bạn là nhân viên chăm sóc khách hàng của cửa hàng công nghệ VISTA.
Hãy viết MỘT phản hồi ngắn bằng tiếng Việt cho đánh giá sau của khách hàng.

Sản phẩm: ${productName || "Sản phẩm"}
Khách hàng: ${customerName || "Khách hàng"}
Số sao: ${rating}/5
Nội dung đánh giá: "${comment || "(khách không viết nhận xét)"}"

Yêu cầu:
- ${tone}
- Lịch sự, thân thiện, 2 đến 3 câu, dưới 70 từ.
- Không hứa hoàn tiền, không hứa tặng quà hay giảm giá, không bịa chính sách hay thông tin sản phẩm.
- Không chèn đường dẫn, số điện thoại, email.
- Chỉ trả về nội dung phản hồi, không giải thích, không dùng dấu ngoặc kép.`;
}

async function generateReviewReply(input) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("Thiếu GROQ_API_KEY");
  }

  let lastError = null;

  for (const model of GROQ_MODELS) {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        temperature: 0.5,
        ...(model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
        messages: [{ role: "user", content: buildPrompt(input) }],
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    if (response.status === 404 || response.status === 400) {
      const detail = await response.text().catch(() => "");
      lastError = new Error(`Model ${model} lỗi ${response.status}: ${detail.slice(0, 200)}`);
      continue;
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`AI Service trả về lỗi ${response.status}: ${detail.slice(0, 300)}`);
    }

    const data = await response.json();
    const text = String(data?.choices?.[0]?.message?.content || "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^["“”\s]+|["“”\s]+$/g, "")
      .trim();

    if (!text) {
      lastError = new Error(`Model ${model} không trả về nội dung`);
      continue;
    }

    return text.slice(0, 1000);
  }

  throw lastError || new Error("AI Service không khả dụng");
}

module.exports = { generateReviewReply };
