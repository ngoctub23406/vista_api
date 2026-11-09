/**
 * promotion-helper.js
 * Module dùng chung xử lý nghiệp vụ Khuyến mãi & Voucher VISTA:
 * - Chuẩn hóa ngày giờ theo múi giờ Việt Nam (Asia/Ho_Chi_Minh - GMT+7).
 * - Bóc tách fallback cho voucher cũ (Legacy voucher text extractor).
 * - Đánh giá ma trận 6 trạng thái hiệu lực tiếng Việt theo thứ tự ưu tiên.
 */

const VOUCHER_COUNTED_ORDER_STATUSES = [
  "pending_payment",
  "processing",
  "shipping",
  "delivered",
  "review",
  "returning",
];

function cleanString(val) {
  return String(val || "").trim();
}

function normalizeText(value) {
  return cleanString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

/**
 * Phân tích chuỗi ngày giờ sang Date UTC theo múi giờ Asia/Ho_Chi_Minh (UTC+7)
 * Hỗ trợ:
 * - ISO: YYYY-MM-DDTHH:mm hoặc YYYY-MM-DDTHH:mm:ss...
 * - YYYY-MM-DD (không có giờ)
 * - DD/MM/YYYY (định dạng legacy của seed VISTA cũ)
 */
function parseVoucherDateTime(dateStr, isEndOfDay = false) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return dateStr;

  const raw = cleanString(dateStr);
  if (!raw) return null;

  // Trường hợp DD/MM/YYYY (Legacy)
  const dmyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, "0");
    const month = dmyMatch[2].padStart(2, "0");
    const year = dmyMatch[3];
    const timePart = isEndOfDay ? "23:59:59.999" : "00:00:00.000";
    return new Date(`${year}-${month}-${day}T${timePart}+07:00`);
  }

  // Trường hợp YYYY-MM-DD (chỉ có ngày)
  const ymdMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    const timePart = isEndOfDay ? "23:59:59.999" : "00:00:00.000";
    return new Date(`${raw}T${timePart}+07:00`);
  }

  // Trường hợp YYYY-MM-DDTHH:mm (từ input datetime-local HTML)
  const dtMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (dtMatch) {
    const sec = dtMatch[6] ? dtMatch[6] : (isEndOfDay ? "59.999" : "00.000");
    // Nếu chưa có timezone offset, bổ sung +07:00 (giờ VN)
    if (!raw.includes("+") && !raw.includes("Z")) {
      return new Date(`${dtMatch[1]}-${dtMatch[2]}-${dtMatch[3]}T${dtMatch[4]}:${dtMatch[5]}:${sec}+07:00`);
    }
  }

  // Thử parse thông thường
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format Date sang chuỗi ISO có múi giờ hoặc định dạng hiển thị giờ VN (ICT)
 */
function formatDateToVNISO(date) {
  if (!date) return "";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";

  // Thêm 7 tiếng (UTC+7)
  const vnTime = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return vnTime.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
}

/**
 * Bóc tách tiền từ chuỗi (Regex hỗ trợ: 5 triệu, 500k, 50.000đ)
 */
function parseMoney(value) {
  const text = normalizeText(value);
  const millionMatch = text.match(/(\d+(?:[.,]\d+)?)\s*(trieu|tr)\b/i);
  if (millionMatch) {
    return Math.round(Number(millionMatch[1].replace(",", ".")) * 1000000);
  }

  const kMatch = text.match(/(\d+(?:[.,]\d+)?)\s*k\b/i);
  if (kMatch) {
    return Math.round(Number(kMatch[1].replace(",", ".")) * 1000);
  }

  const moneyMatch = text.match(/(\d{1,3}(?:[.\s]\d{3})+|\d+)\s*(d|vnd|vnd)?\b/i);
  if (!moneyMatch) {
    return 0;
  }

  return Number(String(moneyMatch[1]).replace(/[.\s]/g, "")) || 0;
}

function parsePercent(value) {
  const match = cleanString(value).match(/(\d+(?:[.,]\d+)?)\s*%/);
  return match ? Number(match[1].replace(",", ".")) : 0;
}

/**
 * Trích xuất fallback các trường số từ chuỗi văn bản cho voucher cũ
 */
function extractLegacyDiscountInfo(voucher) {
  let discountValue = Number(voucher?.discountValue ?? voucher?.discount_value) || 0;
  let minOrderValue = Number(voucher?.minOrderValue ?? voucher?.min_order_value) || 0;
  let maxDiscountAmount = Number(voucher?.maxDiscountAmount ?? voucher?.max_discount_amount) || 0;

  const rawType = cleanString(voucher?.type || "").toLowerCase();
  let normalizedType = rawType;
  if (rawType === "shipping" || voucher?.category === "freeship") {
    normalizedType = "free_shipping";
  } else if (rawType === "fixed" || rawType === "fixed_amount") {
    normalizedType = "fixed_amount";
  } else if (rawType === "percent") {
    normalizedType = "percent";
  }

  let warning = "";

  const allTexts = [
    voucher?.title,
    voucher?.condition,
    voucher?.description,
    ...(Array.isArray(voucher?.benefits) ? voucher.benefits : []),
    ...(Array.isArray(voucher?.conditions) ? voucher.conditions : []),
    voucher?.usageLimit,
  ].filter(Boolean);

  // Fallback minOrderValue
  if (minOrderValue <= 0) {
    for (const text of allTexts) {
      const norm = normalizeText(text);
      if (
        norm.includes("don hang tu") ||
        norm.includes("don tu") ||
        norm.includes("toi thieu") ||
        norm.includes("tu ")
      ) {
        const val = parseMoney(text);
        if (val > 0) {
          minOrderValue = val;
          break;
        }
      }
    }
  }

  // Fallback maxDiscountAmount
  if (maxDiscountAmount <= 0) {
    for (const text of allTexts) {
      const norm = normalizeText(text);
      if (norm.includes("toi da")) {
        const val = parseMoney(text);
        if (val > 0) {
          maxDiscountAmount = val;
          break;
        }
      }
    }
  }

  // Xử lý riêng mã LAPTOP150: đã xác minh từ seed và checkout logic là ưu đãi giảm 150.000đ tiền mặt
  if (cleanString(voucher?.code).toUpperCase() === "LAPTOP150") {
    normalizedType = "fixed_amount";
    if (discountValue <= 0) {
      for (const text of allTexts) {
        const val = parseMoney(text);
        if (val > 0) {
          discountValue = val;
          break;
        }
      }
      if (discountValue <= 0) discountValue = 150000;
    }
    warning = "Mã LAPTOP150: type trong seed là percent nhưng nghiệp vụ thực tế là giảm 150.000đ tiền mặt";
  } else if (normalizedType === "percent") {
    // Voucher percent: chỉ bóc tách tỷ lệ % hợp lệ (1-100%)
    if (discountValue <= 0) {
      for (const text of allTexts) {
        const p = parsePercent(text);
        if (p > 0 && p <= 100) {
          discountValue = p;
          break;
        }
      }
    }

    // Nếu type là percent nhưng không có % trong text mà lại chứa tiền mặt
    if (discountValue <= 0) {
      let hasMoneyText = false;
      for (const text of allTexts) {
        if (parseMoney(text) > 0) {
          hasMoneyText = true;
          break;
        }
      }
      if (hasMoneyText) {
        warning = "Voucher khai báo type percent nhưng nội dung mô tả chứa số tiền mặt thay vì tỷ lệ %";
      }
    }
  } else if (normalizedType === "free_shipping") {
    // Voucher freeship: bóc tách mức giảm tối đa nếu có (ví dụ: Giảm 30K phí vận chuyển)
    if (maxDiscountAmount <= 0 && discountValue <= 0) {
      for (const text of allTexts) {
        const norm = normalizeText(text);
        if (norm.includes("phi van chuyen") || norm.includes("giam")) {
          const val = parseMoney(text);
          if (val > 0) {
            maxDiscountAmount = val;
            discountValue = val;
            break;
          }
        }
      }
    }
  } else {
    // Voucher fixed_amount: bóc tách số tiền giảm trực tiếp
    if (discountValue <= 0) {
      for (const text of allTexts) {
        const norm = normalizeText(text);
        if (norm.includes("giam") || norm.includes("truc tiep")) {
          const val = parseMoney(text);
          if (val > 0) {
            discountValue = val;
            break;
          }
        }
      }
    }
  }

  return {
    discountValue,
    minOrderValue,
    maxDiscountAmount,
    normalizedType,
    warning,
  };
}

/**
 * Đánh giá trạng thái hiệu lực tiếng Việt theo đúng thứ tự ưu tiên:
 * 1. Bản nháp (draft)
 * 2. Đã tạm dừng (paused)
 * 3. Đã sử dụng (used - từ dữ liệu seed legacy)
 * 4. Đã kết thúc (expired - quá hạn thời gian)
 * 5. Đã hết lượt (out_of_quota - khi có giới hạn hợp lệ và đã đạt trần)
 * 6. Sắp diễn ra (upcoming - chưa tới ngày bắt đầu)
 * 7. Sắp hết hạn (expiring - cảnh báo hiệu lực)
 * 8. Đang diễn ra (active)
 */
function resolvePromotionStatus(voucher, usedCount = 0, now = new Date()) {
  const rawStatus = cleanString(voucher?.status).toLowerCase();

  // 1. Bản nháp
  if (rawStatus === "draft") {
    return {
      status: "draft",
      statusLabel: "Bản nháp",
      badgeClass: "status-draft",
      isUsable: false,
    };
  }

  // 2. Đã tạm dừng (Ưu tiên cao hơn thời gian!)
  if (rawStatus === "paused") {
    return {
      status: "paused",
      statusLabel: "Đã tạm dừng",
      badgeClass: "status-paused",
      isUsable: false,
    };
  }

  // 3. Đã hết lượt (Trạng thái 'used' từ seed legacy: trong ngữ cảnh quản trị khuyến mãi Admin quy về "Đã hết lượt")
  if (rawStatus === "used") {
    return {
      status: "out_of_quota",
      statusLabel: "Đã hết lượt",
      badgeClass: "status-expired",
      isUsable: false,
    };
  }

  // Phân tích thời gian
  const startDate = parseVoucherDateTime(voucher?.startDate, false);
  const endDate = parseVoucherDateTime(voucher?.endDate || voucher?.expiry, true);

  // 4. Đã kết thúc (Quá hạn thời gian)
  if (endDate && now > endDate) {
    return {
      status: "expired",
      statusLabel: "Đã kết thúc",
      badgeClass: "status-expired",
      isUsable: false,
    };
  }

  // 5. Đã hết lượt (Chỉ khi có giới hạn sử dụng hợp lệ > 0 VÀ usedCount >= usageLimit)
  const usageLimit = Number(voucher?.usage_limit) || 0;
  if (usageLimit > 0 && usedCount >= usageLimit) {
    return {
      status: "out_of_quota",
      statusLabel: "Đã hết lượt",
      badgeClass: "status-expired",
      isUsable: false,
    };
  }

  // 6. Sắp diễn ra (Chưa tới thời điểm bắt đầu)
  if (startDate && now < startDate) {
    return {
      status: "upcoming",
      statusLabel: "Sắp diễn ra",
      badgeClass: "status-upcoming",
      isUsable: false,
    };
  }

  // 7. Nhãn cảnh báo sắp hết hạn (nếu rawStatus là expiring)
  if (rawStatus === "expiring") {
    return {
      status: "active",
      statusLabel: "Sắp hết hạn",
      badgeClass: "status-warning",
      isUsable: true,
      isExpiringSoon: true,
    };
  }

  // 8. Đang diễn ra
  return {
    status: "active",
    statusLabel: "Đang diễn ra",
    badgeClass: "status-active",
    isUsable: true,
  };
}

module.exports = {
  VOUCHER_COUNTED_ORDER_STATUSES,
  parseVoucherDateTime,
  formatDateToVNISO,
  extractLegacyDiscountInfo,
  resolvePromotionStatus,
};

