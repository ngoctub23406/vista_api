const { Order, User, Payment, Delivery, Order_detail, Product_variant, Return_order } = require('../models/schema');
const {
  ORDER_EVENTS,
  SYSTEM_ACTOR,
  buildHistoryEntry,
  isOrderConfirmed,
  hasCustomerConfirmation,
  tryCompleteOrder,
} = require('../services/order-status.service');
const { notifyOrderEvent } = require('../services/notification.service');
const { CUSTOMER_CANCEL_REASONS, codeFromLabel } = require('../services/reason-catalog');

const IMMUTABLE_STATUSES = new Set(['returning', 'cancelled', 'delivered']);
const SHIPPING_STATUSES = new Set(['shipping', 'delivering']);
const REVIEW_DISPLAY_STATUSES = new Set(['review', 'delivered']);
const PENDING_PAYMENT_AUTO_CANCEL_MS = 24 * 60 * 60 * 1000;
const CANCELLABLE_STATUSES = new Set(['pending_payment', 'processing']);

function cleanText(value) {
  return String(value || '').trim();
}

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

function buildReturnReasonLabel(value) {
  const reason = cleanText(value);
  return RETURN_REASON_LABELS[reason] || reason || 'Chưa có lý do hoàn trả.';
}

function summarizeReturnRequests(returnRequests) {
  const requests = Array.isArray(returnRequests) ? returnRequests : [];
  const sortedRequests = [...requests].sort((a, b) => new Date(b.Created_at || 0) - new Date(a.Created_at || 0));
  const latest = sortedRequests[0] || null;
  const evidenceImages = [...new Set(requests.flatMap((item) => Array.isArray(item.Evidence_images) ? item.Evidence_images : []))];
  const refundAmount = requests.reduce((sum, item) => sum + (Number(item.Refund_amount) || 0), 0);
  const reasonType = cleanText(latest?.Reason_type || '');
  const returnItemMap = new Map();

  requests.forEach((item) => {
    const variantId = cleanText(item.Product_variant_id || '');
    if (!variantId) {
      return;
    }

    const current = returnItemMap.get(variantId) || {
      Return_order_id: cleanText(item.Return_order_id || ''),
      Product_variant_id: variantId,
      Return_quantity: 0,
      Refund_amount: 0,
      Status: cleanText(item.Status || ''),
    };

    current.Return_quantity += Math.max(1, Number(item.Return_quantity || 1) || 1);
    current.Refund_amount += Number(item.Refund_amount) || 0;
    current.Status = current.Status || cleanText(item.Status || '');
    returnItemMap.set(variantId, current);
  });

  const returnItems = Array.from(returnItemMap.values());
  const returnRequestSummaries = sortedRequests.map((item) => ({
    Return_order_id: cleanText(item.Return_order_id || ''),
    Product_variant_id: cleanText(item.Product_variant_id || ''),
    Return_quantity: Math.max(1, Number(item.Return_quantity || 1) || 1),
    Refund_amount: Number(item.Refund_amount) || 0,
    Reason_type: cleanText(item.Reason_type || ''),
    Description: cleanText(item.Description || ''),
    Status: cleanText(item.Status || ''),
    Created_at: item.Created_at || null,
  }));

  return {
    Return_requests: returnRequestSummaries,
    Return_items: returnItems,
    Return_order_id: latest?.Return_order_id || '',
    Return_product_variant_id: latest?.Product_variant_id || '',
    Return_reason_type: reasonType,
    Return_reason: buildReturnReasonLabel(reasonType),
    Return_description: cleanText(latest?.Description || ''),
    Return_status: cleanText(latest?.Status || ''),
    Return_created_at: latest?.Created_at || null,
    Return_refund_amount: refundAmount,
    Return_name: cleanText(latest?.Return_name || ''),
    Return_phone: cleanText(latest?.Return_phone || ''),
    Return_email: cleanText(latest?.Return_email || ''),
    Return_address: cleanText(latest?.Return_address || ''),
    Return_tracking_number: cleanText(latest?.Return_tracking_number || ''),
    Return_evidence_images: evidenceImages,
  };
}


function normalizeStatusValue(value) {
  const normalized = cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (!normalized) {
    return '';
  }

  if (['dang giao', 'dang van chuyen', 'delivering', 'shipping'].includes(normalized)) {
    return 'shipping';
  }

  if (['da giao', 'da nhan duoc hang', 'delivered'].includes(normalized)) {
    return 'delivered';
  }

  if (['cho xu ly', 'processing'].includes(normalized)) {
    return 'processing';
  }

  if (['cho thanh toan', 'pending_payment'].includes(normalized)) {
    return 'pending_payment';
  }

  if (['danh gia', 'review'].includes(normalized)) {
    return 'review';
  }

  if (['da huy', 'cancelled', 'cancel'].includes(normalized)) {
    return 'cancelled';
  }

  if (['tra hang', 'returning'].includes(normalized)) {
    return 'returning';
  }

  return normalized;
}

function normalizePaymentType(value) {
  const normalized = cleanText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');

  if (['cod', 'cash', 'tien mat', 'tienmat', 'thanh toan tien mat', 'thanh toan khi nhan hang'].includes(normalized)) {
    return 'COD';
  }

  if (['banktransfer', 'qr', 'chuyen khoan', 'chuyen khoan qr', 'chuyen khoan ngan hang'].includes(normalized)) {
    return 'BankTransfer';
  }

  return cleanText(value) || 'COD';
}

function buildShippingAddress(addressSnapshot) {
  if (!addressSnapshot) {
    return '';
  }

  return [
    addressSnapshot.Specific_address,
    addressSnapshot.Ward,
    addressSnapshot.District,
    addressSnapshot.Province,
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(', ');
}

function resolveHistoryStatus(order, paymentInfo) {
  const paymentType = normalizePaymentType(paymentInfo?.Payment_type);
  const paymentStatus = cleanText(paymentInfo?.Payment_status || 'pending');
  const currentStatus = normalizeStatusValue(order?.Status);
  const createdAt = order?.Created_at ? new Date(order.Created_at) : null;
  const isBankTransfer = paymentType === 'BankTransfer';

  if (IMMUTABLE_STATUSES.has(currentStatus)) {
    return currentStatus;
  }

  let nextStatus = currentStatus;

  if (isBankTransfer) {
    if (paymentStatus === 'paid') {
      nextStatus = currentStatus && currentStatus !== 'pending_payment' ? currentStatus : 'processing';
    } else {
      const pendingPaymentAge = createdAt && !Number.isNaN(createdAt.getTime())
        ? Date.now() - createdAt.getTime()
        : null;

      nextStatus = pendingPaymentAge !== null && pendingPaymentAge >= PENDING_PAYMENT_AUTO_CANCEL_MS
        ? 'cancelled'
        : 'pending_payment';
    }
  } else if (currentStatus !== 'shipping' && currentStatus !== 'review') {
    nextStatus = currentStatus === 'shipping' || currentStatus === 'review'
      ? currentStatus
      : 'processing';
  }

  // Bỏ tự chuyển sang "Đang giao" sau 90 giây: Staff xử lý đơn và giả lập ĐVVC cập nhật trạng thái

  if (!nextStatus) {
    nextStatus = isBankTransfer ? 'pending_payment' : 'processing';
  }

  return nextStatus;
}

function shouldShowReceivedAction(order) {
  return SHIPPING_STATUSES.has(normalizeStatusValue(order?.Status));
}

function shouldShowReviewStatus(order) {
  return REVIEW_DISPLAY_STATUSES.has(normalizeStatusValue(order?.Status));
}

const getOrderHistory = async (req, res) => {
  try {
    const userId = req.params.userId;
    const statusFilter = req.query.status;
    const matchStage = { User_id: userId };

    let orders = await Order.aggregate([
      { $match: matchStage },
      {
        $lookup: {
          from: 'User',
          localField: 'User_id',
          foreignField: 'User_id',
          as: 'UserInfo'
        }
      },
      {
        $lookup: {
          from: 'Payment',
          localField: 'Order_id',
          foreignField: 'Order_id',
          as: 'PaymentInfo'
        }
      },
      {
        $lookup: {
          from: 'Delivery',
          localField: 'Order_id',
          foreignField: 'Order_id',
          as: 'DeliveryInfo'
        }
      },
      {
        $lookup: {
          from: 'Order_detail',
          let: { orderId: '$Order_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$Order_id', '$$orderId'] } } },
            {
              $lookup: {
                from: 'Product_variant',
                localField: 'Product_variant_id',
                foreignField: 'Product_variant_id',
                as: 'VariantInfo'
              }
            },
            { $unwind: { path: '$VariantInfo', preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from: 'Product',
                localField: 'VariantInfo.Product_id',
                foreignField: 'Product_id',
                as: 'ProductInfo'
              }
            },
            { $unwind: { path: '$ProductInfo', preserveNullAndEmptyArrays: true } },
            {
              $lookup: {
                from: 'Review',
                localField: 'Order_detail_id',
                foreignField: 'Order_detail_id',
                as: 'ReviewInfo'
              }
            },
            {
              $unwind: {
                path: '$ReviewInfo',
                preserveNullAndEmptyArrays: true
              }
            },
          ],
          as: 'RawItems'
        }
      },
      {
        $lookup: {
          from: 'Return_order',
          localField: 'Order_id',
          foreignField: 'Order_id',
          as: 'ReturnInfo'
        }
      },
      { $sort: { Created_at: -1 } }
    ]).allowDiskUse(true);

    let formattedOrders = await Promise.all(orders.map(async (order, index) => {
      const userInfo = order.UserInfo && order.UserInfo.length > 0 ? order.UserInfo[0] : null;
      const paymentInfo = order.PaymentInfo && order.PaymentInfo.length > 0 ? order.PaymentInfo[0] : null;
      const paymentStatus = cleanText(paymentInfo?.Payment_status || 'pending');
      const paymentType = normalizePaymentType(paymentInfo?.Payment_type);
      const deliveryInfo = order.DeliveryInfo && order.DeliveryInfo.length > 0 ? order.DeliveryInfo[0] : null;
      const returnSummary = summarizeReturnRequests(order.ReturnInfo || []);
      const resolvedStatus = resolveHistoryStatus(order, paymentInfo);
      const currentStatus = cleanText(order.Status);
      const orderAddressSnapshot = {
        Receiver_name: cleanText(order.Receiver_name || ''),
        Receiver_phone: cleanText(order.Receiver_phone || ''),
        Email: cleanText(order.Email || ''),
        Province: cleanText(order.Province || ''),
        District: cleanText(order.District || ''),
        Ward: cleanText(order.Ward || ''),
        Specific_address: cleanText(order.Specific_address || ''),
        Address: cleanText(order.Address || ''),
      };
      const snapshotAddress = orderAddressSnapshot.Address || buildShippingAddress(orderAddressSnapshot);
      const displayAddress = snapshotAddress || '';

      if (resolvedStatus && resolvedStatus !== currentStatus) {
        const orderUpdate = { Status: resolvedStatus };

        if (resolvedStatus === 'cancelled') {
          orderUpdate.Cancel_reason = order.Cancel_reason || 'Đơn hàng đã tự động hủy do quá hạn thanh toán.';
          orderUpdate.Cancel_reason_code = order.Cancel_reason_code || 'payment_timeout';
          orderUpdate.Cancelled_by = order.Cancelled_by || 'system';
          orderUpdate.Cancelled_at = order.Cancelled_at || new Date();
        }

        const historyUpdate = resolvedStatus === 'cancelled'
          ? {
            $push: {
              Status_history: buildHistoryEntry({
                fromStatus: order.Status,
                toStatus: 'cancelled',
                event: ORDER_EVENTS.CANCELLED,
                actor: SYSTEM_ACTOR,
                note: orderUpdate.Cancel_reason,
              }),
            },
          }
          : {};

        await Order.updateOne(
          { Order_id: order.Order_id },
          { $set: orderUpdate, ...historyUpdate }
        );
      }

      // Chỉ đẩy Delivery lên "shipping" khi còn ở bước trước đó.
      // Không được ghi đè "delivered" (ĐVVC đã giao) về lại "shipping".
      if (
        resolvedStatus === 'shipping' &&
        !['shipping', 'delivered'].includes(normalizeStatusValue(deliveryInfo?.Status))
      ) {
        await Delivery.updateOne(
          { Order_id: order.Order_id },
          {
            $set: {
              Status: 'shipping',
            }
          }
        );
      }

      const formattedItems = (order.RawItems || []).map((item, i) => {
        const productImage = item.ProductInfo && item.ProductInfo.Images && item.ProductInfo.Images.length > 0
          ? '/assets/images/' + item.ProductInfo.Images[0]
          : '/assets/images/default-product.png';

        const productName = item.ProductInfo ? item.ProductInfo.Product_name : item.Variant_name;
        const variantId = item.Product_variant_id || item.VariantInfo?.Product_variant_id || '';
        const reviewId = cleanText(item.ReviewInfo?.Review_id || '');
        const returnItem = (returnSummary.Return_items || []).find(
          (requestItem) => requestItem.Product_variant_id === variantId
        );

        return {
          Product_id: item.ProductInfo ? item.ProductInfo.Product_id : (i + 1),
          Product_variant_id: variantId,
          productVariantId: variantId,
          Order_detail_id: item.Order_detail_id,
          Review_id: reviewId,
          Review_status: reviewId ? 'reviewed' : 'not_reviewed',
          Review_rating: item.ReviewInfo?.Rating || 0,
          Product_name: productName,
          Variant_name: item.Variant_name,
          Price: item.Price,
          Original_price: item.Original_price || (item.VariantInfo ? item.VariantInfo.Price : 0) || 0,
          Discount_percent: item.Discount_percent || item.ProductInfo?.Discount || 0,
          Quantity: item.Quantity,
          Return_quantity: returnItem?.Return_quantity || 0,
          Return_refund_amount: returnItem?.Refund_amount || 0,
          Is_returned_item: !!returnItem,
          Total_price: item.Total_price || ((item.Price || 0) * (item.Quantity || 0)),
          Image: productImage
        };
      });
      const derivedReviewStatus = formattedItems.length > 0 && formattedItems.every((item) => item.Review_status === 'reviewed')
        ? 'reviewed'
        : 'not_reviewed';
      return {
        Order_id: index + 1, 
        Order_code: order.Order_id, 
        Created_at: order.Created_at,
        Status: resolvedStatus,
        Cancel_reason: resolvedStatus === 'cancelled'
          ? (order.Cancel_reason || 'Đơn hàng đã bị hủy.')
          : (order.Cancel_reason || ''),
        Cancelled_at: order.Cancelled_at || null,
        Return_requests: returnSummary.Return_requests,
        Return_items: returnSummary.Return_items,
        Return_order_id: returnSummary.Return_order_id,
        Return_product_variant_id: returnSummary.Return_product_variant_id,
        Return_reason_type: returnSummary.Return_reason_type,
        Return_reason: returnSummary.Return_reason,
        Return_description: returnSummary.Return_description,
        Return_status: returnSummary.Return_status,
        Return_created_at: returnSummary.Return_created_at,
        Return_refund_amount: returnSummary.Return_refund_amount,
        Return_name: returnSummary.Return_name,
        Return_phone: returnSummary.Return_phone,
        Return_email: returnSummary.Return_email,
        Return_address: returnSummary.Return_address,
        Return_tracking_number: returnSummary.Return_tracking_number,
        Return_evidence_images: returnSummary.Return_evidence_images,
        Review_status: derivedReviewStatus,
        Processing_started_at: order.Processing_started_at || null,
        Is_confirmed: isOrderConfirmed(order),
        Customer_name: orderAddressSnapshot.Receiver_name || userInfo?.Full_name || order.Customer_name || '',
        Phone_number: orderAddressSnapshot.Receiver_phone || userInfo?.Phone_number || order.Phone_number || '',
        Email: orderAddressSnapshot.Email || userInfo?.Email || order.Email || '',
        Address: displayAddress,
        Receiver_name: orderAddressSnapshot.Receiver_name || userInfo?.Full_name || '',
        Receiver_phone: orderAddressSnapshot.Receiver_phone || userInfo?.Phone_number || '',
        Province: orderAddressSnapshot.Province,
        District: orderAddressSnapshot.District,
        Ward: orderAddressSnapshot.Ward,
        Specific_address: orderAddressSnapshot.Specific_address,
        Voucher_id: order.Voucher_id || null,
        Voucher_code: order.Voucher_code || '',
        Voucher_title: order.Voucher_title || '',
        

        Total_items_price: order.Total_items_price || 0,
        Discount_amount: order.Discount_amount || 0,
        Voucher_discount_amount: order.Voucher_discount_amount || 0,
        Voucher_shipping_discount: order.Voucher_shipping_discount || 0,
        Total_amount: order.Total_amount || 0,
        Shipping_fee: deliveryInfo ? Number(deliveryInfo.Shipping_fee) || 0 : 0,
        Delivery_status:
          resolvedStatus === 'shipping'
            ? (deliveryInfo?.Status === 'delivered' ? 'delivered' : 'shipping')
            : resolvedStatus === 'delivered'
              ? 'delivered'
              : deliveryInfo
                ? deliveryInfo.Status || 'pending'
                : 'pending',
        Shipping_partner: deliveryInfo?.Shipping_partner || '',
        Tracking_number: deliveryInfo?.Tracking_number || '',
        Estimated_delivery_date: deliveryInfo?.Estimated_delivery_date || null,
        Delivered_at: deliveryInfo?.Delivered_at || deliveryInfo?.Actual_delivery_date || deliveryInfo?.Received_at || deliveryInfo?.Completed_at || null,
        Payment_type: paymentType,
        Payment_status: paymentStatus,
        Order_notes: order.Order_notes || '',

        
        Items: formattedItems
      };
    }));

    if (statusFilter && statusFilter !== 'all') {
      formattedOrders = formattedOrders.filter((o) => {
        const normalizedStatus = normalizeStatusValue(o.Status);
        if (statusFilter === 'review') {
          return shouldShowReviewStatus(o);
        }

        return normalizedStatus === statusFilter;
      });
    }

    return res.status(200).json({
      success: true,
      data: formattedOrders
    });

  } catch (error) {
    console.error('Lỗi khi lấy lịch sử đơn hàng:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Đã xảy ra lỗi hệ thống khi tải lịch sử đơn hàng' 
    });
  }
};

const markOrderReceived = async (req, res) => {
  try {
    const orderId = cleanText(req.params.orderId);

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu mã đơn hàng.',
      });
    }

    const order = await Order.findOne({ Order_id: orderId }).lean();
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy đơn hàng.',
      });
    }

    const currentStatus = normalizeStatusValue(order.Status);
    if (!shouldShowReceivedAction(order)) {
      return res.status(400).json({
        success: false,
        message: 'Chỉ đơn hàng đang vận chuyển mới có thể xác nhận đã nhận hàng.',
      });
    }

    // Khách chỉ xác nhận được sau khi đơn vị vận chuyển báo đã giao
    const delivery = await Delivery.findOne({ Order_id: orderId }).lean();
    if (delivery?.Status !== 'delivered') {
      return res.status(400).json({
        success: false,
        message: 'Đơn vị vận chuyển chưa xác nhận giao hàng, bạn chưa thể xác nhận đã nhận hàng.',
      });
    }

    if (!hasCustomerConfirmation(order)) {
      await Order.updateOne(
        {
          Order_id: orderId,
          'Status_history.Event': {
            $nin: [ORDER_EVENTS.CUSTOMER_RECEIVED, ORDER_EVENTS.AUTO_RECEIVED],
          },
        },
        {
          $push: {
            Status_history: buildHistoryEntry({
              fromStatus: order.Status,
              toStatus: order.Status,
              event: ORDER_EVENTS.CUSTOMER_RECEIVED,
              actor: { id: order.User_id, name: order.Receiver_name || 'Khách hàng' },
            }),
          },
        }
      );
    }

    // Đủ 2 điều kiện (ĐVVC đã giao + khách xác nhận) thì hoàn tất đơn, cộng Total_spent
    await tryCompleteOrder(orderId);

    const updatedOrder = await Order.findOne({ Order_id: orderId }).select('Status Processing_started_at').lean();
    const payment = await Payment.findOne({ Order_id: orderId }).lean();

    return res.status(200).json({
      success: true,
      message: 'Đã ghi nhận đơn hàng đã được nhận.',
      data: {
        Order_id: orderId,
        Status: updatedOrder?.Status || order.Status,
        previousStatus: currentStatus,
        Delivery_status: 'delivered',
        Payment_status: cleanText(payment?.Payment_status || 'pending'),
        Delivered_at: delivery.Delivered_at || null,
        Processing_started_at: updatedOrder?.Processing_started_at || null,
      },
    });
  } catch (error) {
    console.error('Lỗi khi xác nhận đã nhận hàng:', error);
    return res.status(500).json({
      success: false,
      message: 'Đã xảy ra lỗi hệ thống khi xác nhận đã nhận hàng',
    });
  }
};



const cancelOrder = async (req, res) => {
  try {
    const orderId = cleanText(req.params.orderId);
    const reason = cleanText(req.body?.reason);

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: 'Thiếu mã đơn hàng.',
      });
    }

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Vui lòng chọn lý do hủy đơn hàng.',
      });
    }

    const order = await Order.findOne({ Order_id: orderId }).lean();
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Không tìm thấy đơn hàng.',
      });
    }

    const currentStatus = normalizeStatusValue(order.Status);
    if (currentStatus === 'cancelled') {
      return res.status(200).json({
        success: true,
        message: 'Đơn hàng đã được hủy trước đó.',
        data: {
          Order_id: orderId,
          Status: 'cancelled',
          Cancel_reason: order.Cancel_reason || reason,
          Cancelled_at: order.Cancelled_at || null,
        },
      });
    }

    if (!CANCELLABLE_STATUSES.has(currentStatus) || isOrderConfirmed(order)) {
      return res.status(400).json({
        success: false,
        message: 'Đơn hàng đã được cửa hàng xác nhận, bạn không thể hủy đơn.',
      });
    }

    const cancelledAt = new Date();

    // Cập nhật có điều kiện để không hủy trùng lúc Staff vừa xác nhận đơn
    const cancelResult = await Order.updateOne(
      {
        Order_id: orderId,
        Status: { $in: Array.from(CANCELLABLE_STATUSES) },
        'Status_history.Event': { $ne: ORDER_EVENTS.CONFIRMED },
      },
      {
        $set: {
          Status: 'cancelled',
          Cancel_reason: reason,
          Cancel_reason_code: codeFromLabel(CUSTOMER_CANCEL_REASONS, reason),
          Cancelled_by: 'customer',
          Cancelled_at: cancelledAt,
        },
        $push: {
          Status_history: buildHistoryEntry({
            fromStatus: order.Status,
            toStatus: 'cancelled',
            event: ORDER_EVENTS.CANCELLED,
            actor: { id: order.User_id, name: order.Receiver_name || 'Khách hàng' },
            note: reason,
          }),
        },
      }
    );

    if (cancelResult.modifiedCount === 0) {
      return res.status(400).json({
        success: false,
        message: 'Đơn hàng đã được cửa hàng xác nhận, bạn không thể hủy đơn.',
      });
    }

    const orderDetails = await Order_detail.find({ Order_id: orderId }).lean();

    await Promise.all(
      orderDetails.map((item) =>
        Product_variant.updateOne(
          { Product_variant_id: item.Product_variant_id },
          { $inc: { Stock_quantity: Math.max(0, Number(item.Quantity) || 0) } }
        )
      )
    );

    const payment = await Payment.findOne({ Order_id: orderId }).lean();
    let nextPaymentStatus = cleanText(payment?.Payment_status || 'pending');

    if (payment) {
      const currentPaymentStatus = cleanText(payment.Payment_status).toLowerCase();
      nextPaymentStatus = currentPaymentStatus === 'paid' ? 'refunded' : 'failed';

      await Payment.updateOne(
        { Order_id: orderId },
        {
          $set: {
            Payment_status: nextPaymentStatus,
            Failure_reason: reason,
          },
        }
      );
    }

    await Delivery.updateOne(
      { Order_id: orderId },
      { $set: { Status: 'failed' } }
    );

    notifyOrderEvent(orderId, 'order_cancelled_by_customer');

    return res.status(200).json({
      success: true,
      message: 'Đã hủy đơn hàng thành công.',
      data: {
        Order_id: orderId,
        Status: 'cancelled',
        Cancel_reason: reason,
        Cancelled_at: cancelledAt,
        Payment_status: nextPaymentStatus,
        Delivery_status: 'failed',
      },
    });
  } catch (error) {
    console.error('Lỗi khi hủy đơn hàng:', error);
    return res.status(500).json({
      success: false,
      message: 'Đã xảy ra lỗi hệ thống khi hủy đơn hàng.',
    });
  }
};



const markOrderReviewed = async (req, res) => {
  try {
    const orderId = req.body.orderId || req.body.Order_id || req.body.Order_code; 

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Thiếu mã đơn hàng.' });
    }

    const order = await Order.findOne({ Order_id: orderId }).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: 'Không tìm thấy đơn hàng.' });
    }

    if (order.Review_status === 'reviewed') {
      return res.status(400).json({ success: false, message: 'Đơn hàng này đã được đánh giá trước đó.' });
    }


    await Order.updateOne(
      { Order_id: orderId },
      { $set: { Review_status: 'reviewed' } }
    );

    return res.status(200).json({
      success: true,
      message: 'Đã cập nhật trạng thái đánh giá thành công.'
    });
  } catch (error) {
    console.error('-> LỖI SERVER KHI ĐÁNH GIÁ:', error);
    return res.status(500).json({
      success: false,
      message: 'Lỗi hệ thống khi cập nhật trạng thái đánh giá.'
    });
  }
};

module.exports = {
  getOrderHistory,
  markOrderReceived,
  cancelOrder,
  markOrderReviewed 
};
