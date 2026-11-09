const Wishlist = require("../models/wishlist.model");
const { Product, Product_variant } = require("../models/schema");

const MAX_WISHLIST_ITEMS = 200;
const MAX_LOOKUP_IDS = 100;

function cleanIds(value, limit) {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return Array.from(new Set(ids)).slice(0, limit);
}

// Danh sách Product_id của khách, mới thêm đứng đầu
async function readProductIds(userId) {
  const wishlist = await Wishlist.findOne({ User_id: userId }).lean();
  const items = wishlist?.Items || [];
  return items
    .slice()
    .sort((a, b) => new Date(b.Added_at) - new Date(a.Added_at))
    .map((item) => item.Product_id);
}

async function ensureWishlist(userId) {
  await Wishlist.updateOne(
    { User_id: userId },
    { $setOnInsert: { User_id: userId, Items: [] } },
    { upsert: true }
  );
}

// Khách xem danh sách yêu thích gắn với tài khoản
exports.getWishlist = async (req, res) => {
  try {
    const productIds = await readProductIds(req.user.User_id);
    return res.json({ success: true, data: { productIds } });
  } catch (error) {
    console.error("Lỗi khi lấy danh sách yêu thích:", error);
    return res.status(500).json({ success: false, message: "Không thể tải danh sách yêu thích" });
  }
};

// Thêm một sản phẩm vào yêu thích (thêm lại sản phẩm đã có thì bỏ qua)
exports.addItem = async (req, res) => {
  try {
    const userId = req.user.User_id;
    const productId = String(req.params.productId || "").trim();

    if (!productId) {
      return res.status(400).json({ success: false, message: "Thiếu mã sản phẩm" });
    }

    const product = await Product.findOne({ Product_id: productId }).select("Product_id").lean();
    if (!product) {
      return res.status(404).json({ success: false, message: "Không tìm thấy sản phẩm" });
    }

    const current = await readProductIds(userId);
    if (!current.includes(productId) && current.length >= MAX_WISHLIST_ITEMS) {
      return res.status(400).json({
        success: false,
        message: `Danh sách yêu thích tối đa ${MAX_WISHLIST_ITEMS} sản phẩm`,
      });
    }

    await ensureWishlist(userId);
    await Wishlist.updateOne(
      { User_id: userId, "Items.Product_id": { $ne: productId } },
      {
        $push: { Items: { Product_id: productId, Added_at: new Date() } },
        $set: { Updated_at: new Date() },
      }
    );

    return res.json({ success: true, data: { productIds: await readProductIds(userId) } });
  } catch (error) {
    console.error("Lỗi khi thêm yêu thích:", error);
    return res.status(500).json({ success: false, message: "Không thể thêm vào yêu thích" });
  }
};

// Bỏ một sản phẩm khỏi yêu thích
exports.removeItem = async (req, res) => {
  try {
    const userId = req.user.User_id;
    const productId = String(req.params.productId || "").trim();

    await Wishlist.updateOne(
      { User_id: userId },
      { $pull: { Items: { Product_id: productId } }, $set: { Updated_at: new Date() } }
    );

    return res.json({ success: true, data: { productIds: await readProductIds(userId) } });
  } catch (error) {
    console.error("Lỗi khi bỏ yêu thích:", error);
    return res.status(500).json({ success: false, message: "Không thể bỏ khỏi yêu thích" });
  }
};

// Xóa toàn bộ danh sách yêu thích
exports.clearWishlist = async (req, res) => {
  try {
    await Wishlist.updateOne(
      { User_id: req.user.User_id },
      { $set: { Items: [], Updated_at: new Date() } }
    );
    return res.json({ success: true, data: { productIds: [] } });
  } catch (error) {
    console.error("Lỗi khi xóa danh sách yêu thích:", error);
    return res.status(500).json({ success: false, message: "Không thể xóa danh sách yêu thích" });
  }
};

// Gộp danh sách đang lưu trên trình duyệt (Guest hoặc máy này) vào tài khoản sau khi đăng nhập
exports.mergeWishlist = async (req, res) => {
  try {
    const userId = req.user.User_id;
    const incoming = cleanIds(req.body?.productIds, MAX_WISHLIST_ITEMS);

    if (incoming.length > 0) {
      const existingProducts = await Product.find({ Product_id: { $in: incoming } })
        .select("Product_id")
        .lean();
      const validIds = new Set(existingProducts.map((product) => product.Product_id));

      const current = new Set(await readProductIds(userId));
      const room = Math.max(0, MAX_WISHLIST_ITEMS - current.size);

      // Giữ đúng thứ tự trên trình duyệt: phần tử đứng sau được coi là thêm trước
      const toAdd = incoming
        .filter((id) => validIds.has(id) && !current.has(id))
        .slice(0, room);

      if (toAdd.length > 0) {
        const now = Date.now();
        await ensureWishlist(userId);
        await Wishlist.updateOne(
          { User_id: userId },
          {
            $push: {
              Items: {
                $each: toAdd.map((id, index) => ({
                  Product_id: id,
                  Added_at: new Date(now - index),
                })),
              },
            },
            $set: { Updated_at: new Date() },
          }
        );
      }
    }

    return res.json({ success: true, data: { productIds: await readProductIds(userId) } });
  } catch (error) {
    console.error("Lỗi khi gộp danh sách yêu thích:", error);
    return res.status(500).json({ success: false, message: "Không thể đồng bộ danh sách yêu thích" });
  }
};

// Lấy thông tin hiển thị cho danh sách mã sản phẩm (dùng cho cả Guest, không cần đăng nhập)
exports.lookupProducts = async (req, res) => {
  try {
    const ids = cleanIds(req.body?.productIds, MAX_LOOKUP_IDS);
    if (ids.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const [products, variants] = await Promise.all([
      Product.find({ Product_id: { $in: ids } }).lean(),
      Product_variant.find({ Product_id: { $in: ids } }).sort({ Price: 1 }).lean(),
    ]);

    const variantsByProduct = new Map();
    variants.forEach((variant) => {
      const list = variantsByProduct.get(variant.Product_id) || [];
      list.push({
        Product_variant_id: variant.Product_variant_id,
        Variant_name: variant.Variant_name,
        Price: variant.Price,
        Stock_quantity: Math.max(0, Number(variant.Stock_quantity) || 0),
      });
      variantsByProduct.set(variant.Product_id, list);
    });

    const productById = new Map(products.map((product) => [product.Product_id, product]));

    // Trả về đúng thứ tự mã gửi lên; sản phẩm không còn tồn tại sẽ bị bỏ qua
    const cards = ids
      .map((id) => productById.get(id))
      .filter(Boolean)
      .map((product) => {
        const productVariants = variantsByProduct.get(product.Product_id) || [];
        const inStock = productVariants.filter((variant) => variant.Stock_quantity > 0);
        const totalStock = productVariants.reduce((sum, variant) => sum + variant.Stock_quantity, 0);
        const priceSource = inStock.length > 0 ? inStock : productVariants;

        let status = "on_sale";
        if (product.Status === "discontinued") {
          status = "discontinued";
        } else if (product.Status === "out_of_stock" || totalStock <= 0) {
          status = "out_of_stock";
        }

        return {
          Product_id: product.Product_id,
          Product_name: product.Product_name,
          Image: (product.Images && product.Images[0]) || "",
          Discount: Number(product.Discount) || 0,
          Is_AI: !!product.Is_AI,
          Is_Flash_Sale: !!product.Is_Flash_Sale,
          Average_rating: Number(product.Average_rating) || 0,
          Technical_specs: product.Technical_specs || {},
          Status: status,
          Min_price: priceSource.length > 0 ? priceSource[0].Price : 0,
          Variants: productVariants,
        };
      });

    return res.json({ success: true, data: cards });
  } catch (error) {
    console.error("Lỗi khi tải sản phẩm yêu thích:", error);
    return res.status(500).json({ success: false, message: "Không thể tải sản phẩm yêu thích" });
  }
};
