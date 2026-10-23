const { Order, Order_detail, Return_order, User } = require('../models/schema');
const { notifyOrderEvent } = require('../services/notification.service');
const { ORDER_EVENTS, buildHistoryEntry } = require('../services/order-status.service');
const { RETURN_REASONS, codesFromText } = require('../services/reason-catalog');

const RETURNABLE_ORDER_STATUSES = new Set(['delivered', 'review']);
const ACTIVE_RETURN_STATUSES = ['pending', 'approved', 'completed', 'refunded'];

const RETURN_REASON_LABELS = {
  damaged: 'Hàng lỗi, không hoạt động',
  not_as_described: 'Khác với mô tả',
  used_item: 'Hàng đã qua sử dụng',
  counterfeit: 'Hàng giả, nhái',
  missing_accessories: 'Hàng nguyên vẹn nhưng không còn nhu cầu',
  wrong_item: 'Giao sai sản phẩm',
  changed_mind: 'Không còn nhu cầu',
  other: 'Lý do khác',
};

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

function normalizeStatus(value) {
  const normalized = normalizeText(value);

  if (['da giao', 'delivered', 'review', 'danh gia'].includes(normalized)) {
    return normalized === 'review' || normalized === 'danh gia' ? 'review' : 'delivered';
  }

  if (['tra hang', 'returning'].includes(normalized)) {
    return 'returning';
  }

  return normalized;
}

function buildReturnId(index = 0) {
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return 'RTN_' + Date.now() + '_' + (index + 1) + '_' + random;
}

function buildReturnTrackingNumber(index = 0) {
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return 'SPXRTN' + Date.now().toString().slice(-9) + (index + 1) + random;
}

function toMoney(value) {
  return Math.max(0, Number(value) || 0);
}

function buildItemMap(items) {
  return new Map(items.map((item) => [cleanText(item.Product_variant_id), item]));
}

function resolveSelectedItems(orderDetails, selectedItems) {
  if (!Array.isArray(selectedItems) || selectedItems.length === 0) {
    return orderDetails.map((item) => ({
      Product_variant_id: item.Product_variant_id,
      Quantity: item.Quantity,
    }));
  }

  const detailMap = buildItemMap(orderDetails);

  return selectedItems
    .map((item) => {
      const variantId = cleanText(item.Product_variant_id || item.productVariantId);
      const detail = detailMap.get(variantId);

      if (!detail) {
        return null;
      }

      const detailQuantity = Math.max(1, Number(detail.Quantity) || 1);
      const requestedQuantity = Math.max(1, Number(item.Quantity || item.quantity || detailQuantity) || 1);

      return {
        Product_variant_id: variantId,
        Quantity: Math.min(requestedQuantity, detailQuantity),
      };
    })
    .filter(Boolean);
}

function getOrderItemsSubtotal(orderDetails) {
  return orderDetails.reduce((sum, detail) => {
    return sum + toMoney(detail.Price) * Math.max(1, Number(detail.Quantity) || 1);
  }, 0);
}

function getSelectedItemsSubtotal(selectedItems, detailMap) {
  return selectedItems.reduce((sum, selectedItem) => {
    const detail = detailMap.get(selectedItem.Product_variant_id);
    const quantity = Math.max(1, Number(selectedItem.Quantity) || 1);
    return sum + toMoney(detail?.Price) * quantity;
  }, 0);
}

function getTotalPurchasedQuantity(orderDetails) {
  return orderDetails.reduce((sum, detail) => {
    return sum + Math.max(1, Number(detail.Quantity) || 1);
  }, 0);
}

function getSelectedReturnQuantity(selectedItems) {
  return selectedItems.reduce((sum, selectedItem) => {
    return sum + Math.max(1, Number(selectedItem.Quantity) || 1);
  }, 0);
}

function isFullOrderReturn(orderDetails, selectedItems) {
  if (orderDetails.length !== selectedItems.length) {
    return false;
  }

  const selectedMap = buildItemMap(selectedItems);
  return orderDetails.every((detail) => {
    const selectedItem = selectedMap.get(cleanText(detail.Product_variant_id));
    return selectedItem && Number(selectedItem.Quantity) === Number(detail.Quantity);
  });
}

function allocateRefundAmounts(order, orderDetails, selectedItems, detailMap) {
  const orderItemsSubtotal = getOrderItemsSubtotal(orderDetails);
  const paidAmount = toMoney(order.Total_amount) || orderItemsSubtotal;
  const totalPurchasedQuantity = Math.max(1, getTotalPurchasedQuantity(orderDetails));
  const selectedReturnQuantity = getSelectedReturnQuantity(selectedItems);
  const orderAdjustment = paidAmount - orderItemsSubtotal;
  const adjustmentPerUnit = orderAdjustment / totalPurchasedQuantity;

  const targetRefundAmount = isFullOrderReturn(orderDetails, selectedItems)
    ? paidAmount
    : Math.max(0, Math.round(getSelectedItemsSubtotal(selectedItems, detailMap) + adjustmentPerUnit * selectedReturnQuantity));

  let allocated = 0;
  return selectedItems.map((selectedItem, index) => {
    if (index === selectedItems.length - 1) {
      return Math.max(0, targetRefundAmount - allocated);
    }

    const detail = detailMap.get(selectedItem.Product_variant_id);
    const quantity = Math.max(1, Number(selectedItem.Quantity) || 1);
    const itemSubtotal = toMoney(detail?.Price) * quantity;
    const amount = Math.max(0, Math.round(itemSubtotal + adjustmentPerUnit * quantity));
    allocated += amount;
    return Math.max(0, amount);
  });
}

function buildReturnSummary(returnRequests) {
  const requests = Array.isArray(returnRequests) ? returnRequests : [];
  const refundAmount = requests.reduce((sum, item) => sum + toMoney(item.Refund_amount), 0);
  const sorted = [...requests].sort((a, b) => new Date(b.Created_at || 0) - new Date(a.Created_at || 0));
  const latest = sorted[0] || null;
  const requestSummaries = sorted.map((item) => ({
    Return_order_id: cleanText(item.Return_order_id || ''),
    Product_variant_id: cleanText(item.Product_variant_id || ''),
    Return_quantity: Math.max(1, Number(item.Return_quantity || 1) || 1),
    Refund_amount: toMoney(item.Refund_amount),
    Reason_type: cleanText(item.Reason_type || ''),
    Description: cleanText(item.Description || ''),
    Status: cleanText(item.Status || ''),
    Created_at: item.Created_at || null,
  }));

  return {
    requests: requestSummaries,
    latest,
    refundAmount,
    reasonType: latest ? cleanText(latest.Reason_type) : '',
    reasonLabel: latest ? (cleanText(latest.Reason_type) || 'Chưa có lý do hoàn trả') : '',
    description: latest ? cleanText(latest.Description) : '',
    status: latest ? cleanText(latest.Status || 'pending') : '',
    createdAt: latest ? latest.Created_at : null,
    returnName: latest ? cleanText(latest.Return_name) : '',
    returnPhone: latest ? cleanText(latest.Return_phone) : '',
    returnEmail: latest ? cleanText(latest.Return_email) : '',
    returnAddress: latest ? cleanText(latest.Return_address) : '',
    returnTrackingNumber: latest ? cleanText(latest.Return_tracking_number) : '',
    evidenceImages: [...new Set(requests.flatMap((item) => Array.isArray(item.Evidence_images) ? item.Evidence_images : []))],
  };
}

async function findReturnRequests(orderId) {
  return Return_order.find({ Order_id: orderId }).sort({ Created_at: -1 }).lean();
}

const createReturnOrder = async (req, res) => {
  try {
    const orderId = cleanText(req.body?.Order_id || req.body?.orderId);
    const reasonType = cleanText(req.body?.Reason_type || req.body?.reasonType);
    const description = cleanText(req.body?.Description || req.body?.description);
    const returnName = cleanText(req.body?.Return_name || req.body?.returnName);
    const returnPhone = cleanText(req.body?.Return_phone || req.body?.returnPhone);
    const returnEmail = cleanText(req.body?.Return_email || req.body?.returnEmail);
    const returnAddress = cleanText(req.body?.Return_address || req.body?.returnAddress);
    const evidenceImages = Array.isArray(req.body?.Evidence_images || req.body?.evidenceImages)
      ? (req.body.Evidence_images || req.body.evidenceImages).map(cleanText).filter(Boolean)
      : [];

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu mã đơn hàng cần hoàn trả.',
      });
    }

    if (!reasonType) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng chọn lý do hoàn trả.',
      });
    }

    if (!description) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng nhập mô tả chi tiết cho yêu cầu hoàn trả.',
      });
    }

    if (!returnName || !returnPhone || !returnEmail || !returnAddress) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng nhập đầy đủ thông tin trả hàng.',
      });
    }

    if (evidenceImages.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng thêm ít nhất một hình ảnh hoặc video bằng chứng.',
      });
    }

    const order = await Order.findOne({ Order_id: orderId }).lean();
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy đơn hàng.',
      });
    }

    const currentStatus = normalizeStatus(order.Status);
    if (currentStatus === 'returning') {
      const existingRequests = await findReturnRequests(orderId);
      return res.status(200).json({
        success: true,
        message: 'Đơn hàng này đã có yêu cầu hoàn trả trước đó.',
        data: {
          Order_id: orderId,
          Return_order_id: existingRequests[0]?.Return_order_id || '',
          Status: 'returning',
          returnSummary: buildReturnSummary(existingRequests),
        },
      });
    }

    if (!RETURNABLE_ORDER_STATUSES.has(currentStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Chỉ đơn hàng đã giao hoặc đang ở mục đánh giá mới có thể yêu cầu hoàn trả.',
      });
    }

    const activeReturn = await Return_order.findOne({
      Order_id: orderId,
      Status: { $in: ACTIVE_RETURN_STATUSES },
    }).lean();

    if (activeReturn) {
      return res.status(409).json({
        success: false,
        message: 'Đơn hàng đã có yêu cầu hoàn trả đang được xử lý.',
      });
    }

    const orderDetails = await Order_detail.find({ Order_id: orderId }).lean();
    if (!orderDetails.length) {
      return res.status(400).json({
        success: false,
        message: 'Đơn hàng không có sản phẩm để hoàn trả.',
      });
    }

    const selectedItems = resolveSelectedItems(orderDetails, req.body?.items || req.body?.Items);
    if (!selectedItems.length) {
      return res.status(400).json({
        success: false,
        message: 'Không tìm thấy sản phẩm hoàn trả hợp lệ trong đơn hàng.',
      });
    }

    const detailMap = buildItemMap(orderDetails);
    const createdAt = new Date();
    const refundAmounts = allocateRefundAmounts(order, orderDetails, selectedItems, detailMap);

    const returnDocuments = selectedItems.map((selectedItem, index) => {
      const detail = detailMap.get(selectedItem.Product_variant_id);
      const quantity = Math.max(1, Number(selectedItem.Quantity) || 1);
      const refundAmount = refundAmounts[index] || 0;

      return {
        Return_order_id: buildReturnId(index),
        Order_id: orderId,
        Product_variant_id: selectedItem.Product_variant_id,
        Return_quantity: quantity,
        Reason_type: reasonType,
        Reason_codes: codesFromText(RETURN_REASONS, reasonType),
        Description: description,
        Evidence_images: index === 0 ? evidenceImages : [],
        Refund_amount: refundAmount,
        Return_name: returnName,
        Return_phone: returnPhone,
        Return_email: returnEmail,
        Return_address: returnAddress,
        Return_tracking_number: buildReturnTrackingNumber(index),
        Status: 'refunded',
        Created_at: createdAt,
      };
    });

    const createdRequests = await Return_order.insertMany(returnDocuments);

    await Order.updateOne(
      { Order_id: orderId },
      {
        $set: { Status: 'returning' },
        $push: {
          Status_history: buildHistoryEntry({
            fromStatus: order.Status,
            toStatus: 'returning',
            event: ORDER_EVENTS.RETURN_REQUESTED,
            actor: { id: order.User_id, name: order.Receiver_name || 'Khách hàng' },
            note: reasonType,
          }),
        },
      }
    );
    // ==========================================
    // LOGIC TRỪ ĐIỂM: CHỈ TRỪ ĐÚNG SỐ TIỀN HOÀN TRẢ
    // ==========================================
    const userId = order.User_id;
    // Tính tổng số tiền hoàn của đợt trả hàng này
    const totalRefundAmount = returnDocuments.reduce((sum, doc) => sum + (Number(doc.Refund_amount) || 0), 0);

    if (userId && totalRefundAmount > 0) {
      // 1. Trừ điểm tương ứng với số tiền hoàn trả
      await User.updateOne(
        { User_id: userId },
        { $inc: { Total_spent: -totalRefundAmount } }
      );
      
      // 2. Chốt chặn an toàn: Nếu lỡ điểm bị âm thì set về 0
      await User.updateOne(
        { User_id: userId, Total_spent: { $lt: 0 } },
        { $set: { Total_spent: 0 } }
      );
      
      console.log(`Đã TRỪ ${totalRefundAmount} điểm của User ${userId} do hoàn hàng`);
    }
    // ==========================================

    notifyOrderEvent(orderId, 'return_requested');

    return res.status(201).json({
      success: true,
      message: 'Đã gửi yêu cầu hoàn trả thành công.',
      data: {
        Order_id: orderId,
        Return_order_id: returnDocuments[0]?.Return_order_id || '',
        Status: 'returning',
        returnSummary: buildReturnSummary(createdRequests.map((item) => item.toObject ? item.toObject() : item)),
      },
    });
  } catch (error) {
    console.error('Lỗi khi tạo yêu cầu hoàn trả:', error);
    return res.status(500).json({
      success: false,
      message: 'Đã xảy ra lỗi hệ thống khi tạo yêu cầu hoàn trả.',
    });
  }
};

const getReturnOrderByOrderId = async (req, res) => {
  try {
    const orderId = cleanText(req.params.orderId);

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu mã đơn hàng.',
      });
    }

    const returnRequests = await findReturnRequests(orderId);

    return res.status(200).json({
      success: true,
      data: buildReturnSummary(returnRequests),
    });
  } catch (error) {
    console.error('Lỗi khi lấy yêu cầu hoàn trả:', error);
    return res.status(500).json({
      success: false,
      message: 'Đã xảy ra lỗi hệ thống khi tải thông tin hoàn trả.',
    });
  }
};

module.exports = {
  createReturnOrder,
  getReturnOrderByOrderId,
};
