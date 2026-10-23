// Danh mục lý do chuẩn hóa: lưu mã (code) để sau này làm báo cáo,
// nhãn (label) để hiển thị. Đổi chữ hiển thị ở đây, không đổi code.

// Staff hủy đơn
const STAFF_CANCEL_REASONS = [
  { code: "out_of_stock", label: "Hết hàng" },
  { code: "cannot_contact", label: "Không liên hệ được khách hàng" },
  { code: "invalid_shipping_info", label: "Địa chỉ hoặc SĐT giao hàng không hợp lệ" },
  { code: "suspected_fraud", label: "Nghi ngờ đơn ảo, gian lận" },
  { code: "customer_request", label: "Khách yêu cầu hủy" },
  { code: "pricing_error", label: "Sai giá sản phẩm" },
  { code: "other", label: "Lý do khác", requiresNote: true },
];

// Khách tự hủy đơn (trùng nhãn với danh sách ở trang Lịch sử đơn hàng)
const CUSTOMER_CANCEL_REASONS = [
  { code: "change_address", label: "Tôi muốn cập nhật địa chỉ/SĐT nhận hàng" },
  { code: "change_voucher", label: "Tôi muốn thêm/thay đổi mã giảm giá" },
  { code: "change_product", label: "Tôi muốn thay đổi sản phẩm (kích thước, màu sắc, số lượng...)" },
  { code: "payment_trouble", label: "Thủ tục thanh toán rắc rối" },
  { code: "found_better_offer", label: "Tôi tìm thấy chỗ mua khác tốt hơn (rẻ hơn, uy tín hơn, giao nhanh hơn...)" },
  { code: "no_longer_needed", label: "Tôi không có nhu cầu mua nữa" },
  { code: "other", label: "Tôi không tìm thấy lý do hủy phù hợp" },
];

// Hệ thống tự hủy
const SYSTEM_CANCEL_REASONS = [
  { code: "payment_timeout", label: "Đơn hàng đã tự động hủy do quá hạn thanh toán." },
];

// Lý do hoàn trả (trùng với trang Hoàn trả)
const RETURN_REASONS = [
  { code: "damaged", label: "Hàng lỗi, không hoạt động" },
  { code: "not_as_described", label: "Khác với mô tả" },
  { code: "used_item", label: "Hàng đã qua sử dụng" },
  { code: "counterfeit", label: "Hàng giả, nhái" },
  { code: "missing_accessories", label: "Hàng nguyên vẹn nhưng không còn nhu cầu" },
  { code: "wrong_item", label: "Giao sai sản phẩm" },
  { code: "changed_mind", label: "Không còn nhu cầu" },
  { code: "other", label: "Lý do khác" },
];

function findByCode(catalog, code) {
  return catalog.find((item) => item.code === String(code || "").trim()) || null;
}

// Đổi nhãn khách chọn thành mã; không khớp thì xếp vào "other"
function codeFromLabel(catalog, label) {
  const text = String(label || "").trim();
  return catalog.find((item) => item.label === text)?.code || "other";
}

// Lý do hoàn trả có thể chọn nhiều, ghép thành 1 chuỗi → lấy tất cả mã khớp
function codesFromText(catalog, text) {
  const value = String(text || "");
  const codes = catalog
    .filter((item) => item.code !== "other" && value.includes(item.label))
    .map((item) => item.code);
  return codes.length ? codes : ["other"];
}

module.exports = {
  STAFF_CANCEL_REASONS,
  CUSTOMER_CANCEL_REASONS,
  SYSTEM_CANCEL_REASONS,
  RETURN_REASONS,
  findByCode,
  codeFromLabel,
  codesFromText,
};
