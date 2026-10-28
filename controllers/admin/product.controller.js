const { randomUUID } = require("crypto");
const { Product, Product_variant, Category, Brand } = require("../../models/schema");

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const PRODUCT_STATUSES = ["on_sale", "out_of_stock"];
const VARIANT_STATUSES = ["active", "out_of_stock"];
const MAX_ID_GENERATION_ATTEMPTS = 5;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateOptionalString(value, fieldName) {
  return value === undefined || typeof value === "string"
    ? null
    : `${fieldName} phải là chuỗi`;
}

function validateOptionalNumber(value, fieldName, { min, max } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${fieldName} phải là số hợp lệ`;
  }
  if (min !== undefined && value < min) {
    return `${fieldName} phải lớn hơn hoặc bằng ${min}`;
  }
  if (max !== undefined && value > max) {
    return `${fieldName} phải nhỏ hơn hoặc bằng ${max}`;
  }
  return null;
}

function validateProductInput(body) {
  if (!isObject(body)) {
    return { error: "Dữ liệu sản phẩm không hợp lệ" };
  }

  const productName = typeof body.Product_name === "string" ? body.Product_name.trim() : "";
  const categoryId = typeof body.Category_id === "string" ? body.Category_id.trim() : "";
  const brandId = typeof body.Brand_id === "string" ? body.Brand_id.trim() : "";

  if (!productName) return { error: "Product_name là bắt buộc" };
  if (!categoryId) return { error: "Category_id là bắt buộc" };
  if (!brandId) return { error: "Brand_id là bắt buộc" };
  if (!Array.isArray(body.variants) || body.variants.length === 0) {
    return { error: "Sản phẩm phải có ít nhất một biến thể" };
  }

  if (hasOwn(body, "Description")) {
    const error = validateOptionalString(body.Description, "Description");
    if (error) return { error };
  }

  if (hasOwn(body, "Images") &&
      (!Array.isArray(body.Images) || body.Images.some((image) => typeof image !== "string"))) {
    return { error: "Images phải là mảng chuỗi" };
  }

  if (hasOwn(body, "Average_rating")) {
    const error = validateOptionalNumber(body.Average_rating, "Average_rating", { min: 0, max: 5 });
    if (error) return { error };
  }
  if (hasOwn(body, "Total_reviews")) {
    const error = validateOptionalNumber(body.Total_reviews, "Total_reviews");
    if (error) return { error };
  }
  if (hasOwn(body, "Discount")) {
    const error = validateOptionalNumber(body.Discount, "Discount", { min: 0, max: 100 });
    if (error) return { error };
  }
  for (const fieldName of ["Is_Flash_Sale", "Is_AI"]) {
    if (hasOwn(body, fieldName) && typeof body[fieldName] !== "boolean") {
      return { error: `${fieldName} phải là boolean` };
    }
  }
  if (hasOwn(body, "Status") && !PRODUCT_STATUSES.includes(body.Status)) {
    return { error: `Status phải là một trong: ${PRODUCT_STATUSES.join(", ")}` };
  }

  const variants = [];
  for (const [index, variant] of body.variants.entries()) {
    if (!isObject(variant)) {
      return { error: `variants[${index}] không hợp lệ` };
    }
    if (typeof variant.Variant_name !== "string" || !variant.Variant_name.trim()) {
      return { error: `variants[${index}].Variant_name là bắt buộc` };
    }

    const priceError = validateOptionalNumber(variant.Price, `variants[${index}].Price`);
    if (priceError) return { error: priceError };
    if (variant.Price <= 0) {
      return { error: `variants[${index}].Price phải lớn hơn 0` };
    }
    if (typeof variant.Stock_quantity !== "number" ||
        !Number.isSafeInteger(variant.Stock_quantity) ||
        variant.Stock_quantity < 0) {
      return { error: `variants[${index}].Stock_quantity phải là số nguyên không âm` };
    }
    if (hasOwn(variant, "Status") && !VARIANT_STATUSES.includes(variant.Status)) {
      return { error: `variants[${index}].Status phải là một trong: ${VARIANT_STATUSES.join(", ")}` };
    }

    variants.push({
      Variant_name: variant.Variant_name.trim(),
      Attributes: variant.Attributes,
      Price: variant.Price,
      Stock_quantity: variant.Stock_quantity,
      Status: variant.Stock_quantity === 0 ? "out_of_stock" : "active",
    });
  }

  return {
    product: {
      Category_id: categoryId,
      Brand_id: brandId,
      Product_name: productName,
      ...(hasOwn(body, "Description") ? { Description: body.Description } : {}),
      ...(hasOwn(body, "Images") ? { Images: body.Images } : {}),
      ...(hasOwn(body, "Technical_specs") ? { Technical_specs: body.Technical_specs } : {}),
      ...(hasOwn(body, "Average_rating") ? { Average_rating: body.Average_rating } : {}),
      ...(hasOwn(body, "Total_reviews") ? { Total_reviews: body.Total_reviews } : {}),
      Discount: hasOwn(body, "Discount") ? body.Discount : 0,
      Is_Flash_Sale: hasOwn(body, "Is_Flash_Sale") ? body.Is_Flash_Sale : false,
      Is_AI: hasOwn(body, "Is_AI") ? body.Is_AI : false,
    },
    variants,
  };
}

function isDuplicateKeyError(error) {
  if (error?.code === 11000) return true;

  const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
  const resultWriteErrors = typeof error?.result?.getWriteErrors === "function"
    ? error.result.getWriteErrors()
    : [];
  return [...writeErrors, ...resultWriteErrors].some((writeError) => writeError.code === 11000);
}

function isTransactionUnsupportedError(error) {
  const message = String(error?.message || "");
  return error?.code === 20 ||
    error?.codeName === "IllegalOperation" ||
    /Transaction numbers are only allowed|transactions are not supported|replica set member or mongos/i.test(message);
}

function createGeneratedIds(product, variants) {
  const Product_id = `PRD_${randomUUID()}`;
  return {
    product: { ...product, Product_id },
    variants: variants.map((variant) => ({
      ...variant,
      Product_variant_id: `VAR_${randomUUID()}`,
      Product_id,
    })),
  };
}

async function saveWithTransaction(product, variants) {
  const session = await Product.db.startSession();
  let savedProduct;
  let savedVariants;
  try {
    await session.withTransaction(async () => {
      [savedProduct] = await Product.create([product], { session });
      savedVariants = await Product_variant.insertMany(variants, { session, ordered: true });
    });
    return { product: savedProduct, variants: savedVariants };
  } finally {
    await session.endSession();
  }
}

async function saveWithRollback(product, variants) {
  let productSaved = false;
  try {
    const [savedProduct] = await Product.create([product]);
    productSaved = true;
    const savedVariants = await Product_variant.insertMany(variants, { ordered: true });
    return { product: savedProduct, variants: savedVariants };
  } catch (error) {
    if (productSaved) {
      try {
        await Product_variant.deleteMany({ Product_id: product.Product_id });
        await Product.deleteOne({ Product_id: product.Product_id });
      } catch (rollbackError) {
        console.error("Không thể hoàn tác khi tạo sản phẩm thất bại:", rollbackError);
        const rollbackFailure = new Error("Không thể hoàn tác dữ liệu sản phẩm chưa hoàn chỉnh");
        rollbackFailure.cause = rollbackError;
        throw rollbackFailure;
      }
    }
    throw error;
  }
}

function cleanText(value) {
  return String(value || "").trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBooleanFilter(value, fieldName) {
  if (value === undefined || value === "") {
    return { valid: true };
  }

  if (value === "true" || value === "false") {
    return { valid: true, value: value === "true" };
  }

  return { valid: false, message: `${fieldName} phải là true hoặc false` };
}

function parsePriceFilter(value, fieldName) {
  if (value === undefined || value === "") {
    return { valid: true };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { valid: false, message: `${fieldName} phải là số không âm` };
  }

  return { valid: true, value: parsed };
}

async function getProductRelations(products) {
  const productIds = products.map((product) => product.Product_id);
  const categoryIds = [...new Set(products.map((product) => product.Category_id).filter(Boolean))];
  const brandIds = [...new Set(products.map((product) => product.Brand_id).filter(Boolean))];

  const [variants, categories, brands] = await Promise.all([
    productIds.length
      ? Product_variant.find({ Product_id: { $in: productIds } }).sort({ Price: 1 }).lean()
      : [],
    categoryIds.length ? Category.find({ Category_id: { $in: categoryIds } }).lean() : [],
    brandIds.length ? Brand.find({ Brand_id: { $in: brandIds } }).lean() : [],
  ]);

  const variantsByProduct = new Map();
  variants.forEach((variant) => {
    const productVariants = variantsByProduct.get(variant.Product_id) || [];
    productVariants.push(variant);
    variantsByProduct.set(variant.Product_id, productVariants);
  });

  return {
    variantsByProduct,
    categoriesById: new Map(categories.map((category) => [category.Category_id, category])),
    brandsById: new Map(brands.map((brand) => [brand.Brand_id, brand])),
  }
}

exports.createProduct = async (req, res) => {
  try {
    if (!req.body.Brand_id) {
      const defaultBrand = await Brand.findOne().lean();
      if (defaultBrand) req.body.Brand_id = defaultBrand.Brand_id;
    }
    const validated = validateProductInput(req.body);
    if (validated.error) {
      return res.status(400).json({ success: false, message: validated.error });
    }

    const [category, brand] = await Promise.all([
      Category.findOne({ Category_id: validated.product.Category_id }).lean(),
      Brand.findOne({ Brand_id: validated.product.Brand_id }).lean(),
    ]);
    if (!category) {
      return res.status(400).json({ success: false, message: "Category_id không tồn tại" });
    }
    if (!brand) {
      return res.status(400).json({ success: false, message: "Brand_id không tồn tại" });
    }

    const productStatus = validated.variants.every((variant) => variant.Stock_quantity === 0)
      ? "out_of_stock"
      : "on_sale";
    const productInput = { ...validated.product, Status: productStatus };
    let transactionsSupported = true;

    for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
      const generated = createGeneratedIds(productInput, validated.variants);
      try {
        let saved;
        if (transactionsSupported) {
          try {
            saved = await saveWithTransaction(generated.product, generated.variants);
          } catch (error) {
            if (!isTransactionUnsupportedError(error)) throw error;
            transactionsSupported = false;
            saved = await saveWithRollback(generated.product, generated.variants);
          }
        } else {
          saved = await saveWithRollback(generated.product, generated.variants);
        }

        return res.status(201).json({
          success: true,
          message: "Tạo sản phẩm thành công",
          data: {
            ...saved.product.toObject(),
            variants: saved.variants.map((variant) => variant.toObject()),
            category,
            brand,
          },
        });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
    }

    return res.status(409).json({
      success: false,
      message: "Không thể sinh mã sản phẩm duy nhất, vui lòng thử lại",
    });
  } catch (error) {
    console.error("Lỗi khi tạo sản phẩm Admin:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tạo sản phẩm",
    });
  }
};

exports.getProducts = async (req, res) => {
  try {
    const keyword = cleanText(req.query.keyword ?? req.query.search);
    const categoryId = cleanText(req.query.categoryId);
    const brandId = cleanText(req.query.brandId);
    const status = cleanText(req.query.status);
    const requestedPage = Number(req.query.page);
    const requestedLimit = Number(req.query.limit);
    const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(requestedLimit)))
      : DEFAULT_PAGE_SIZE;

    if (status && !PRODUCT_STATUSES.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `status phải là một trong: ${PRODUCT_STATUSES.join(", ")}`,
      });
    }

    const isFlashSale = parseBooleanFilter(req.query.isFlashSale, "isFlashSale");
    const isAI = parseBooleanFilter(req.query.isAI, "isAI");
    const minPrice = parsePriceFilter(req.query.minPrice, "minPrice");
    const maxPrice = parsePriceFilter(req.query.maxPrice, "maxPrice");

    for (const parsedFilter of [isFlashSale, isAI, minPrice, maxPrice]) {
      if (!parsedFilter.valid) {
        return res.status(400).json({ success: false, message: parsedFilter.message });
      }
    }

    if (minPrice.value !== undefined && maxPrice.value !== undefined && minPrice.value > maxPrice.value) {
      return res.status(400).json({
        success: false,
        message: "minPrice không được lớn hơn maxPrice",
      });
    }

    const filter = {};
    if (keyword) {
      const regex = new RegExp(escapeRegex(keyword), "i");
      filter.$or = [
        { Product_id: regex },
        { Product_name: regex },
        { Description: regex },
      ];
    }
    if (categoryId) filter.Category_id = categoryId;
    if (brandId) filter.Brand_id = brandId;
    if (status) filter.Status = status;
    if (isFlashSale.value !== undefined) filter.Is_Flash_Sale = isFlashSale.value;
    if (isAI.value !== undefined) filter.Is_AI = isAI.value;

    if (minPrice.value !== undefined || maxPrice.value !== undefined) {
      const priceFilter = {};
      if (minPrice.value !== undefined) priceFilter.$gte = minPrice.value;
      if (maxPrice.value !== undefined) priceFilter.$lte = maxPrice.value;
      const matchingProductIds = await Product_variant.distinct("Product_id", { Price: priceFilter });
      filter.Product_id = { $in: matchingProductIds };
    }

    const [total, products] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter)
        .sort({ _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const relations = await getProductRelations(products);
    const items = products.map((product) => ({
      ...product,
      variants: relations.variantsByProduct.get(product.Product_id) || [],
      category: relations.categoriesById.get(product.Category_id) || null,
      brand: relations.brandsById.get(product.Brand_id) || null,
    }));

    return res.json({
      success: true,
      data: { items, total, page, limit },
    });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách sản phẩm Admin:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tải danh sách sản phẩm",
    });
  }
};

exports.getProductById = async (req, res) => {
  try {
    const product = await Product.findOne({ Product_id: cleanText(req.params.id) }).lean();
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm",
      });
    }

    const [variants, category, brand] = await Promise.all([
      Product_variant.find({ Product_id: product.Product_id }).sort({ Price: 1 }).lean(),
      Category.findOne({ Category_id: product.Category_id }).lean(),
      Brand.findOne({ Brand_id: product.Brand_id }).lean(),
    ]);

    return res.json({
      success: true,
      data: { ...product, variants, category: category || null, brand: brand || null },
    });
  } catch (error) {
    console.error("Lỗi khi lấy chi tiết sản phẩm Admin:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tải chi tiết sản phẩm",
    });
  }
};


exports.updateProduct = async (req, res) => {
  try {
    const productId = cleanText(req.params.id);
    if (!req.body.Brand_id) {
      const defaultBrand = await Brand.findOne().lean();
      if (defaultBrand) req.body.Brand_id = defaultBrand.Brand_id;
    }
    const existing = await Product.findOne({ Product_id: productId });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm",
      });
    }

    const validated = validateProductInput(req.body);
    if (validated.error) {
      return res.status(400).json({ success: false, message: validated.error });
    }

    const [category, brand] = await Promise.all([
      Category.findOne({ Category_id: validated.product.Category_id }).lean(),
      Brand.findOne({ Brand_id: validated.product.Brand_id }).lean(),
    ]);

    if (!category) {
      return res.status(400).json({ success: false, message: "Category_id không tồn tại" });
    }
    if (!brand) {
      return res.status(400).json({ success: false, message: "Brand_id không tồn tại" });
    }

    const productStatus = validated.variants.every((variant) => variant.Stock_quantity === 0)
      ? "out_of_stock"
      : "on_sale";

    const variantsToInsert = validated.variants.map((variant) => ({
      ...variant,
      Product_variant_id: `VAR_${randomUUID()}`,
      Product_id: productId,
    }));

    await Product_variant.deleteMany({ Product_id: productId });
    const savedVariants = await Product_variant.insertMany(variantsToInsert, { ordered: true });

    const updatedProduct = await Product.findOneAndUpdate(
      { Product_id: productId },
      { ...validated.product, Status: productStatus },
      { new: true }
    ).lean();

    return res.json({
      success: true,
      message: "Cập nhật sản phẩm thành công",
      data: {
        ...updatedProduct,
        variants: savedVariants.map((v) => (typeof v.toObject === "function" ? v.toObject() : v)),
        category,
        brand,
      },
    });
  } catch (error) {
    console.error("Lỗi khi cập nhật sản phẩm Admin:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể cập nhật sản phẩm",
    });
  }
};

exports.deleteProduct = async (req, res) => {
  try {
    const productId = cleanText(req.params.id);
    const existing = await Product.findOne({ Product_id: productId });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy sản phẩm",
      });
    }

    await Promise.all([
      Product_variant.deleteMany({ Product_id: productId }),
      Product.deleteOne({ Product_id: productId }),
    ]);

    return res.json({
      success: true,
      message: "Xóa sản phẩm thành công",
    });
  } catch (error) {
    console.error("Lỗi khi xóa sản phẩm Admin:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể xóa sản phẩm",
    });
  }
};

exports.getCategories = async (req, res) => {
  try {
    const categories = await Category.find().lean();
    return res.json({ success: true, data: categories });
  } catch (error) {
    console.error("Lỗi khi lấy danh mục Admin:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tải danh mục",
    });
  }
};

exports.getBrands = async (req, res) => {
  try {
    const brands = await Brand.find()
      .select("Brand_id Brand_name Description Origin_country")
      .lean();
    return res.json({ success: true, data: brands });
  } catch (error) {
    console.error("Lỗi khi lấy thương hiệu Admin:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể tải thương hiệu",
    });
  }
};


exports.bulkImportProducts = async (req, res) => {
  try {
    const rawItems = Array.isArray(req.body.products) ? req.body.products : [];
    if (rawItems.length === 0) {
      return res.status(400).json({ success: false, message: "Danh sách sản phẩm trống" });
    }

    const [categories, brands] = await Promise.all([
      Category.find({}).lean(),
      Brand.find({}).lean(),
    ]);

    const defaultCategory = categories[0] || { Category_id: "CAT_DEFAULT" };
    const defaultBrand = brands[0] || { Brand_id: "BRD_DEFAULT" };

    const validProducts = [];
    const validVariants = [];
    const errors = [];

    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      const productName = cleanText(item.Product_name);
      if (!productName) {
        errors.push({ row: i + 1, error: "Tên sản phẩm không được để trống" });
        continue;
      }

      const price = Number(item.Price);
      if (!Number.isFinite(price) || price <= 0) {
        errors.push({ row: i + 1, error: `Giá bán "${item.Price}" không hợp lệ` });
        continue;
      }

      const stockQuantity = Number.isInteger(Number(item.Stock_quantity)) && Number(item.Stock_quantity) >= 0
        ? Number(item.Stock_quantity)
        : 0;

      let matchedCategory = defaultCategory;
      if (item.Category_name) {
        const catNameLower = cleanText(item.Category_name).toLowerCase();
        const found = categories.find((c) =>
          c.Category_name.toLowerCase() === catNameLower ||
          c.Category_id.toLowerCase() === catNameLower
        );
        if (found) matchedCategory = found;
      } else if (item.Category_id) {
        const found = categories.find((c) => c.Category_id === item.Category_id);
        if (found) matchedCategory = found;
      }

      let matchedBrand = defaultBrand;
      if (item.Brand_name) {
        const brandNameLower = cleanText(item.Brand_name).toLowerCase();
        const found = brands.find((b) =>
          b.Brand_name.toLowerCase() === brandNameLower ||
          b.Brand_id.toLowerCase() === brandNameLower
        );
        if (found) matchedBrand = found;
      } else if (item.Brand_id) {
        const found = brands.find((b) => b.Brand_id === item.Brand_id);
        if (found) matchedBrand = found;
      }

      const productId = `PRD_${randomUUID()}`;
      const sku = cleanText(item.sku) || `SKU_${Date.now()}_${i + 1}`;

      const techSpecs = item.Technical_specs && typeof item.Technical_specs === "object"
        ? { ...item.Technical_specs, sku }
        : { sku };

      const images = Array.isArray(item.Images) ? item.Images : (item.Image ? [item.Image] : []);

      const productDoc = {
        Product_id: productId,
        Category_id: matchedCategory.Category_id,
        Brand_id: matchedBrand.Brand_id,
        Product_name: productName,
        Description: cleanText(item.Description) || "",
        Images: images,
        Technical_specs: techSpecs,
        Status: stockQuantity > 0 ? "on_sale" : "out_of_stock",
        Discount: Number(item.Discount) || 0,
        Is_Flash_Sale: Boolean(item.Is_Flash_Sale),
        Is_AI: Boolean(item.Is_AI),
      };

      const variantName = cleanText(item.Variant_name) || "Phiên bản tiêu chuẩn";
      const variantDoc = {
        Product_variant_id: `VAR_${randomUUID()}`,
        Product_id: productId,
        Variant_name: variantName,
        Attributes: { sku },
        Price: price,
        Stock_quantity: stockQuantity,
        Status: stockQuantity > 0 ? "active" : "out_of_stock",
      };

      validProducts.push(productDoc);
      validVariants.push(variantDoc);
    }

    if (validProducts.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Không có sản phẩm nào hợp lệ để nhập",
        errors,
      });
    }

    await Promise.all([
      Product.insertMany(validProducts, { ordered: false }),
      Product_variant.insertMany(validVariants, { ordered: false }),
    ]);

    return res.status(201).json({
      success: true,
      message: `Đã nhập thành công ${validProducts.length} sản phẩm`,
      data: {
        importedCount: validProducts.length,
        skippedCount: errors.length,
        errors,
      },
    });
  } catch (error) {
    console.error("Lỗi khi nhập sản phẩm hàng loạt Admin:", error);
    return res.status(500).json({
      success: false,
      message: "Không thể nhập sản phẩm hàng loạt",
      error: error.message,
    });
  }
};
