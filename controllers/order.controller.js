const {
  Address,
  Delivery,
  Order,
  Order_detail,
  Payment,
  Product,
  Product_variant,
} = require("../models/schema");
const { notifyOrderEvent } = require("../services/notification.service");

function cleanString(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeText(value) {
  return cleanString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

function normalizePaymentType(value) {
  const normalized = normalizeText(value);

  if (["cod", "cash", "tien mat", "tienmat", "thanh toan tien mat", "thanh toan khi nhan hang"].includes(normalized)) {
    return "COD";
  }

  if (["banktransfer", "qr", "chuyen khoan", "chuyen khoan qr", "chuyen khoan ngan hang"].includes(normalized)) {
    return "BankTransfer";
  }

  return cleanString(value) || "COD";
}

function buildShippingAddress(address) {
  return [
    cleanString(address?.Specific_address),
    cleanString(address?.Ward),
    cleanString(address?.District),
    cleanString(address?.Province),
  ]
    .filter(Boolean)
    .join(", ");
}

function calculateProductFinalPrice(originalPrice, product) {
  const discount = Math.max(0, Math.min(100, Number(product?.Discount) || 0));
  return Math.round(Number(originalPrice || 0) * (100 - discount) / 100);
}


function validateAddress(address) {
  if (
    !cleanString(address.Receiver_name) ||
    !cleanString(address.Receiver_phone) ||
    !cleanString(address.Email) ||
    !cleanString(address.Province) ||
    !cleanString(address.District) ||
    !cleanString(address.Ward) ||
    !cleanString(address.Specific_address)
  ) {
    return "Vui lòng nhập đầy đủ thông tin nhận hàng.";
  }

  if (!/^(0|\+84)[0-9]{9,10}$/.test(cleanString(address.Receiver_phone).replace(/\s/g, ""))) {
    return "Số điện thoại nhận hàng không hợp lệ.";
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanString(address.Email))) {
    return "Email nhận hàng không hợp lệ.";
  }


  return "";
}

function normalizeOrderDetail(detail, orderId, variant, product) {
  const quantity = Math.max(1, Number(detail.Quantity) || 1);
  const originalPrice = Number(variant.Price) || 0;
  const discountPercent = Math.max(0, Math.min(100, Number(product?.Discount) || 0));
  const price = calculateProductFinalPrice(originalPrice, product);

  return {
    Order_detail_id: cleanString(detail.Order_detail_id),
    Product_variant_id: cleanString(detail.Product_variant_id),
    Order_id: orderId,
    Variant_name: cleanString(detail.Variant_name) || variant.Variant_name,
    Price: price,
    Original_price: originalPrice,
    Discount_percent: discountPercent,
    Quantity: quantity,
    Total_price: price * quantity,
  };
}

exports.createOrder = async (req, res) => {
  try {
    const { order, orderDetails, address, delivery, payment } = req.body || {};

    if (!order || !Array.isArray(orderDetails) || orderDetails.length === 0 || !address || !delivery || !payment) {
      return res.status(400).json({
        success: false,
        message: "Thiếu thông tin tạo đơn hàng.",
      });
    }

    const orderId = cleanString(order.Order_id);
    const userId = cleanString(order.User_id);

    if (!orderId || !userId) {
      return res.status(400).json({
        success: false,
        message: "Thiếu mã đơn hàng hoặc mã người dùng.",
      });
    }

    const addressError = validateAddress(address);
    if (addressError) {
      return res.status(400).json({
        success: false,
        message: addressError,
      });
    }

    const shippingAddressSnapshot = {
      Receiver_name: cleanString(address.Receiver_name),
      Receiver_phone: cleanString(address.Receiver_phone),
      Email: cleanString(address.Email),
      Province: cleanString(address.Province),
      District: cleanString(address.District),
      Ward: cleanString(address.Ward),
      Specific_address: cleanString(address.Specific_address),
      Address: buildShippingAddress(address),
    };

    const variantIds = [...new Set(orderDetails.map((item) => cleanString(item.Product_variant_id)).filter(Boolean))];
    const variants = await Product_variant.find({
      Product_variant_id: { $in: variantIds },
      Status: "active",
    }).lean();
    const variantMap = new Map(variants.map((variant) => [variant.Product_variant_id, variant]));

    if (variantIds.length !== variants.length) {
      return res.status(400).json({
        success: false,
        message: "Một số phiên bản sản phẩm không còn khả dụng.",
      });
    }

    const productIds = [...new Set(variants.map((variant) => variant.Product_id).filter(Boolean))];
    const products = productIds.length
      ? await Product.find({ Product_id: { $in: productIds } }).lean()
      : [];
    const productMap = new Map(products.map((product) => [product.Product_id, product]));

    const normalizedDetails = orderDetails.map((detail) => {
      const variant = variantMap.get(cleanString(detail.Product_variant_id));
      const product = productMap.get(variant.Product_id) || null;
      return normalizeOrderDetail(detail, orderId, variant, product);
    });

    const outOfStockItem = normalizedDetails.find((detail) => {
      const variant = variantMap.get(detail.Product_variant_id);
      const stock = Number(variant.Stock_quantity) || 0;
      return stock > 0 && detail.Quantity > stock;
    });

    if (outOfStockItem) {
      return res.status(400).json({
        success: false,
        message: "Số lượng đặt mua vượt quá tồn kho.",
      });
    }

    const totalItemsPrice = normalizedDetails.reduce((sum, item) => sum + item.Total_price, 0);
    const originalShippingFee = Math.max(
      0,
      Number(delivery.Original_shipping_fee ?? delivery.Shipping_fee) || 0
    );
    const productDiscount = Math.max(
      0,
      Math.min(Number(order.Voucher_discount_amount || order.Discount_amount) || 0, totalItemsPrice)
    );
    const shippingDiscount = Math.max(
      0,
      Math.min(Number(order.Voucher_shipping_discount) || 0, originalShippingFee)
    );
    const appliedVoucher = {
      voucherId: cleanString(order.Voucher_id) || null,
      code: cleanString(order.Voucher_code),
      title: cleanString(order.Voucher_title),
      discountAmount: productDiscount,
      shippingDiscount,
    };
    const shippingFeeAfterDiscount = Math.max(0, originalShippingFee - shippingDiscount);
    const totalDiscount = productDiscount + shippingDiscount;
    const totalAmount = Math.max(0, totalItemsPrice - productDiscount + shippingFeeAfterDiscount);
    const normalizedPaymentType = normalizePaymentType(payment.Payment_type);
    const orderStatus = normalizedPaymentType === "BankTransfer"
      ? "pending_payment"
      : "processing";
    const createdAt = order.Created_at ? new Date(order.Created_at) : new Date();

    await Order.create({
      Order_id: orderId,
      User_id: userId,
      ...shippingAddressSnapshot,
      Status: orderStatus,
      Voucher_id: appliedVoucher.voucherId || null,
      Voucher_code: appliedVoucher.code || "",
      Voucher_title: appliedVoucher.title || "",
      Voucher_discount_amount: productDiscount,
      Voucher_shipping_discount: shippingDiscount,
      Total_items_price: totalItemsPrice,
      Discount_amount: totalDiscount,
      Total_amount: totalAmount,
      Order_notes: cleanString(order.Order_notes),
      Created_at: createdAt,
      Processing_started_at: orderStatus === "processing" ? createdAt : null,
    });

    await Order_detail.insertMany(normalizedDetails);

    if (address.Is_default) {
      await Address.updateMany(
        { User_id: userId, Address_id: { $ne: cleanString(address.Address_id) } },
        { Is_default: false }
      );
    }

    await Address.findOneAndUpdate(
      { Address_id: cleanString(address.Address_id) },
      {
        Address_id: cleanString(address.Address_id),
        User_id: userId,
        Receiver_name: cleanString(address.Receiver_name),
        Receiver_phone: cleanString(address.Receiver_phone),
        Email: cleanString(address.Email),
        Province: cleanString(address.Province),
        District: cleanString(address.District),
        Ward: cleanString(address.Ward),
        Specific_address: cleanString(address.Specific_address),
        Is_default: !!address.Is_default,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await Delivery.create({
      Delivery_id: cleanString(delivery.Delivery_id),
      Order_id: orderId,
      Shipping_partner: cleanString(delivery.Shipping_partner),
      Tracking_number: cleanString(delivery.Tracking_number),
      Original_shipping_fee: originalShippingFee,
      Shipping_discount: shippingDiscount,
      Shipping_fee: shippingFeeAfterDiscount,
      Estimated_delivery_date: delivery.Estimated_delivery_date ? new Date(delivery.Estimated_delivery_date) : null,
      Status: delivery.Status || "pending",
    });

    await Payment.create({
      Payment_id: cleanString(payment.Payment_id),
      Order_id: orderId,
      Payment_type: normalizedPaymentType,
      Payment_status: payment.Payment_status || "pending",
      Amount: totalAmount,
      Transaction_code: cleanString(payment.Transaction_code),
      Paid_at: payment.Payment_status === "paid" ? new Date() : null,
    });

    await Promise.all(
      normalizedDetails.map((detail) =>
        Product_variant.updateOne(
          { Product_variant_id: detail.Product_variant_id },
          { $inc: { Stock_quantity: -detail.Quantity } }
        )
      )
    );

    notifyOrderEvent(orderId, "order_created");

    return res.status(201).json({
      success: true,
      message: "Tạo đơn hàng thành công.",
      data: {
        orderId,
        totalAmount,
        voucher: appliedVoucher,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  }
};
