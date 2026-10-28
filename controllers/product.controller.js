  const { Product, Product_variant, Category, Brand, Review, Order_detail, Order, User } = require("../models/schema");
  const DEFAULT_MOCK_REVIEW_COUNT = Number(process.env.DEFAULT_MOCK_REVIEW_COUNT || 67);

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cleanMediaValue(value) {
    return String(value || '').trim();
  }

  function parseReviewImages(value) {
    if (Array.isArray(value)) {
      return [...new Set(value.flatMap((item) => parseReviewImages(item)).filter(Boolean))];
    }

    if (!value) {
      return [];
    }

    if (typeof value === 'object') {
      const image = cleanMediaValue(
        value.url
        || value.src
        || value.preview
        || value.dataUrl
        || value.dataURL
        || value.fileUrl
        || value.file_url
        || value.filePath
        || value.file_path
        || value.path
        || value.Location
        || value.location
        || value.secure_url
        || value.image
        || value.Image
        || value.video
        || value.Video
        || value.media
        || value.Media
        || value.attachment
        || value.Attachment
        || value.base64
        || value.Base64
        || ''
      );
      return image ? [image] : [];
    }

    const raw = String(value || '').trim();
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw);
      return parseReviewImages(parsed);
    } catch {
      return [raw];
    }
  }

  function maskReviewerName(value) {
    const text = cleanText(value);
    if (!text) {
      return 'Khách hàng VISTA';
    }

    const parts = text.split(' ');
    if (parts.length === 1) {
      return parts[0] + ' ***';
    }

    return parts.slice(0, 2).join(' ') + ' ***';
  }

  async function getPersistedReviewsByProductId(productId) {
    const variants = await Product_variant.find({ Product_id: productId })
      .select('Product_variant_id Variant_name')
      .lean();
    const variantIds = variants.map((item) => item.Product_variant_id).filter(Boolean);

    if (!variantIds.length) {
      return [];
    }

    const orderDetails = await Order_detail.find({ Product_variant_id: { $in: variantIds } }).lean();
    const orderDetailIds = orderDetails.map((item) => item.Order_detail_id).filter(Boolean);

    if (!orderDetailIds.length) {
      return [];
    }

    const reviews = await Review.find({ Order_detail_id: { $in: orderDetailIds } })
      .sort({ Created_at: -1 })
      .lean();

    const orderIds = [...new Set(orderDetails.map((item) => item.Order_id).filter(Boolean))];
    const orders = await Order.find({ Order_id: { $in: orderIds } })
      .select('Order_id User_id')
      .lean();
    const userIds = [...new Set(orders.map((item) => item.User_id).filter(Boolean))];
    const users = await User.find({ User_id: { $in: userIds } })
      .select('User_id Full_name Username')
      .lean();

    const detailMap = new Map(orderDetails.map((item) => [item.Order_detail_id, item]));
    const orderMap = new Map(orders.map((item) => [item.Order_id, item]));
    const userMap = new Map(users.map((item) => [item.User_id, item]));

    return reviews.map((review) => {
      const detail = detailMap.get(review.Order_detail_id) || {};
      const order = orderMap.get(detail.Order_id) || {};
      const user = userMap.get(order.User_id) || {};

      return {
        Review_id: review.Review_id,
        Order_detail_id: review.Order_detail_id,
        Product_variant_id: detail.Product_variant_id || '',
        User_name: maskReviewerName(user.Full_name || user.Username || review.User_name || ''),
        Rating: review.Rating,
        Comment: review.Comment || '',
        Images: parseReviewImages(review.Images),
        Created_at: review.Created_at,
      };
    });
  }


  exports.getAllProducts = async (req, res) => {
    try {
      const { category, brand, minPrice, maxPrice, search, page = 1, limit = 12, sort = "newest", isAI, isNew, isPromo } = req.query;

      const filter = { Status: "on_sale" };
      if (category) filter.Category_id = category;
      
      if (brand) {
        const brandDoc = await Brand.findOne({ Brand_name: { $regex: new RegExp(`^${brand}$`, 'i') } }).lean();
        if (brandDoc) {
          filter.Brand_id = brandDoc.Brand_id;
        } else {
          filter.Brand_id = "NOT_FOUND";
        }
      }
      

      if (req.query.isFlashSale === 'true') {
          filter.Is_Flash_Sale = true;
      } else if (isPromo === 'true') {
          filter.Discount = { $gt: 0 };
          filter.Is_Flash_Sale = { $ne: true }; 
          filter.Is_AI = { $ne: true };
      } else if (isAI === 'true') {
          filter.Is_AI = true;
      } else if (isNew === 'true') {
          filter.Discount = 0;                  
          filter.Is_Flash_Sale = { $ne: true };
          filter.Is_AI = { $ne: true };
      }
      
      let products = await Product.find(filter).lean();


      let productsWithPrice = await Promise.all(
        products.map(async (product) => {
          const variants = await Product_variant.find({
            Product_id: product.Product_id,
            Status: "active",
          }).sort({ Price: 1 }).lean();

          const originalPrice = variants[0]?.Price || 0;
          const discount = product.Discount || 0;

          const finalPrice = discount > 0 ? originalPrice - (originalPrice * discount / 100) : originalPrice;

          return {
            ...product,
            min_price: originalPrice,
            final_price: finalPrice, 
            variants: variants,
          };
        })
      );


      if (minPrice || maxPrice) {
        productsWithPrice = productsWithPrice.filter((p) => {
          if (minPrice && p.final_price < Number(minPrice)) return false;
          if (maxPrice && p.final_price > Number(maxPrice)) return false;
          return true;
        });
      } 

      if (sort === "price_asc") {
        productsWithPrice.sort((a, b) => a.final_price - b.final_price);
      } else if (sort === "price_desc") {
        productsWithPrice.sort((a, b) => b.final_price - a.final_price);
      } else if (sort === "rating") {
        productsWithPrice.sort((a, b) => (b.Average_rating || 0) - (a.Average_rating || 0));
      } else {
        productsWithPrice.sort((a, b) => b._id.toString().localeCompare(a._id.toString()));
      }

      const total = productsWithPrice.length;
      const skip = (Number(page) - 1) * Number(limit);
      const paginatedProducts = productsWithPrice.slice(skip, skip + Number(limit));

      res.json({
        success: true,
        data: paginatedProducts,
        pagination: { total, page: Number(page), limit: Number(limit), totalPages: Math.ceil(total / Number(limit)) },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };


  exports.getProductById = async (req, res) => {
    try {
      const product = await Product.findOne({ Product_id: req.params.id }).lean();
      if (!product) return res.status(404).json({ success: false, message: "Không tìm thấy sản phẩm" });

      const variants = await Product_variant.find({ Product_id: req.params.id }).sort({ Price: 1 }).lean();
      const category = await Category.findOne({ Category_id: product.Category_id }).lean();
      const brand = await Brand.findOne({ Brand_id: product.Brand_id }).lean();
      const reviews = await getPersistedReviewsByProductId(req.params.id);
      const totalReviews = Number(product.Total_reviews || 0);
      const mockReviewCount = totalReviews > reviews.length
        ? totalReviews - reviews.length
        : (reviews.length > 0 ? DEFAULT_MOCK_REVIEW_COUNT : 0);

      res.json({
        success: true,
        data: {
          ...product,
          Total_reviews: mockReviewCount + reviews.length,
          variants,
          category,
          brand,
          Reviews: reviews,
          Review_summary: {
            persistedCount: reviews.length,
            mockReviewCount,
            totalReviews: mockReviewCount + reviews.length,
          },
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };


  exports.getFeaturedProducts = async (req, res) => {
    try {
      const products = await Product.find({
        Status: "on_sale" 
      })
      .sort({ Average_rating: -1 }) 
      .limit(8)
      .lean();

      const productsWithPrice = await Promise.all(
        products.map(async (product) => {
          const variant = await Product_variant.findOne({
            Product_id: product.Product_id,
            Status: "active"
          })
          .sort({ Price: 1 })
          .lean();

          return {
            ...product,
            min_price: variant?.Price || 0
          };
        })
      );

      res.json({ success: true, data: productsWithPrice });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };


  exports.getFlashSaleProducts = async (req, res) => {
    try {
      const products = await Product.find({ Status: "on_sale", Is_Flash_Sale: true })
    .sort({ Discount: -1 })
    .limit(16)
    .lean();
      const productsWithPrice = await Promise.all(
        products.map(async (product) => {
          const variant = await Product_variant.findOne({ Product_id: product.Product_id, Status: "active" }).sort({ Price: 1 }).lean();
          return { ...product, min_price: variant?.Price || 0 };
        })
      );
      res.json({ success: true, data: productsWithPrice });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };


  exports.getAISuggestedProducts = async (req, res) => {
    try {
      const products = await Product.find({
        Status: "on_sale",
        Is_AI: true
      }).limit(8).lean();

      const productsWithPrice = await Promise.all(
        products.map(async (product) => {
          const variant = await Product_variant.findOne({
            Product_id: product.Product_id,
            Status: "active"
          })
          .sort({ Price: 1 })
          .lean();

          return {
            ...product,
            min_price: variant?.Price || 0
          };
        })
      );

      res.json({
        success: true,
        data: productsWithPrice
      });

    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  };

  exports.getAllCategories = async (req, res) => {
    try {
      const categories = await Category.find().lean();
      res.json({ success: true, data: categories });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };

  exports.getAllBrands = async (req, res) => {
    try {
      const brands = await Brand.find()
        .select("Brand_id Brand_name Description Origin_country")
        .lean();
      res.json({ success: true, data: brands });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };


  exports.getRelatedProducts = async (req, res) => {
    try {
      const product = await Product.findOne({ Product_id: req.params.id }).lean();
      if (!product) return res.status(404).json({ success: false, message: "Không tìm thấy sản phẩm" });

      const related = await Product.find({ Category_id: product.Category_id, Product_id: { $ne: req.params.id }, Status: "on_sale" }).limit(4).lean();
      const relatedWithPrice = await Promise.all(
        related.map(async (p) => {
          const variant = await Product_variant.findOne({ Product_id: p.Product_id, Status: "active" }).sort({ Price: 1 }).lean();
          return { ...p, min_price: variant?.Price || 0 };
        })
      );
      res.json({ success: true, data: relatedWithPrice });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };


  exports.getProductsByCategory = async (req, res) => {
    try {
      const products = await Product.find({ Category_id: req.params.categoryId, Status: "on_sale" }).limit(4).lean();
      const productsWithPrice = await Promise.all(
        products.map(async (product) => {
          const variant = await Product_variant.findOne({ Product_id: product.Product_id, Status: "active" }).sort({ Price: 1 }).lean();
          return { ...product, min_price: variant?.Price || 0 };
        })
      );
      res.json({ success: true, data: productsWithPrice });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };


exports.compareProducts = async (req, res) => {
  try {
    const { variantIds } = req.query;
    if (!variantIds) {
      return res.status(400).json({ success: false, message: 'Thiếu variantIds' });
    }

    const ids = variantIds.split(',');
    const results = [];

    for (const variantId of ids) {
      
      const variant = await Product_variant.findOne({ 
        Product_variant_id: variantId,
        Status: 'active'
      }).lean();

      if (!variant) continue;

      
      const product = await Product.findOne({ 
        Product_id: variant.Product_id,
        Status: 'on_sale'
      }).lean();

      if (!product) continue;

      
      const category = await Category.findOne({ Category_id: product.Category_id }).lean();
      const brand = await Brand.findOne({ Brand_id: product.Brand_id }).lean();

      results.push({
        ...product,
        selectedVariantId: variantId,
        variants: [variant], 
        category: category,
        brand: brand
      });
    }

    res.json({ success: true, data: results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

  exports.smartSearch = async (req, res) => {
    try {
      const { query } = req.body;
      const flashKeywords = [
        'ưu đãi', 'uu dai', 'flash sale', 'giảm giá', 'giam gia',
        'khuyến mãi', 'khuyen mai', 'sale hôm nay', 'sale hom nay',
        'đang giảm', 'dang giam', 'hàng sale', 'hang sale'
      ];
      const isFlashIntent = flashKeywords.some(kw =>
        query.toLowerCase().includes(kw)
      );

      if (isFlashIntent) {
        let flashProducts = await Product.find({ Status: 'on_sale', Is_Flash_Sale: true }).lean();
        flashProducts = await Promise.all(flashProducts.map(async (p) => {
          const variant = await Product_variant.findOne({
            Product_id: p.Product_id, Status: 'active'
          }).sort({ Price: 1 }).lean();
          return { ...p, min_price: variant?.Price || 0 };
        }));

        const badges = ['⚡ Flash Sale', '🔥 Giá sốc', '💥 Hot Deal', 'Ưu đãi hôm nay'];
        flashProducts = flashProducts.slice(0, 8).map((p, i) => ({
          ...p,
          aiTag: badges[i % badges.length],
          matchScore: 98
        }));

        return res.json({
          success: true,
          data: flashProducts,
          message: `Tìm thấy ${flashProducts.length} sản phẩm đang Flash Sale hôm nay!`,
          intent: { isFlashSale: true }
        });
      }
      if (!query) return res.status(400).json({ success: false, message: "Thiếu query" });
  

      const brandList = [
        "Apple", "Samsung", "Xiaomi", "ASUS", "HP",
        "Dell", "Lenovo", "Acer", "Sony", "JBL",
        "Oppo", "Vivo", "Realme", "LG", "MSI"
      ];
      const detectedBrand = brandList.find(b =>
        query.toLowerCase().includes(b.toLowerCase())
      );
      console.log("Detected brand from query:", detectedBrand || "none");
  

      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json", 
          "Authorization": `Bearer ${process.env.GROQ_API_KEY}` 
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          response_format: { type: "json_object" }, 
          max_tokens: 256,
          temperature: 0.1, 
          messages: [{
            role: "user",
            content: `Bạn là một trợ lý AI phân tích ý định mua sắm đồ công nghệ. Hãy phân tích yêu cầu của người dùng và trả về một JSON object duy nhất.

  Yêu cầu của người dùng: "${query}"
  
  Định dạng JSON bắt buộc phải theo cấu trúc dưới đây:
  {
    "minPrice": <số nguyên hoặc null. Giá trị tối thiểu khi người dùng yêu cầu giá 'trên', 'khoảng từ', 'hơn'. Ví dụ: "trên 30 triệu" -> 30000000, "từ 15tr" -> 15000000, không có thì để null>,
    "maxPrice": <số nguyên hoặc null. Giá trị tối đa khi người dùng yêu cầu giá 'dưới', 'tầm', 'tối đa'. Ví dụ: "dưới 30 triệu" -> 30000000, "khoảng 15tr trở xuống" -> 15000000, không có thì để null>,
    "category": "<Laptop|Smartphone|Tablet|Thiết bị âm thanh|Phụ kiện công nghệ|Thiết bị gaming|null>",
    "priority": "<performance|price|portability|camera|null>",
    "keyword": "<Từ khóa mô tả dòng sản phẩm, model cụ thể hoặc thông số phần cứng cốt lõi của máy. Hãy lọc bỏ tên hãng thương hiệu, bỏ các cụm từ chỉ giá cả và từ thừa như 'tìm kiếm', 'mua', 'cần'. Ví dụ: 
    - 'mua laptop asus vivobook 15 giá rẻ' -> 'vivobook 15'
    - 'iphone 15 pro max titan tự nhiên' -> '15 pro max'
    - 'tai nghe chụp tai sony wh-1000xm4' -> 'wh-1000xm4'
    - 'máy tính lenovo core i5' -> 'core i5'
    - 'tìm điện thoại s24 ultra dưới 25tr' -> 's24 ultra'
    - Nếu chỉ ghi chung chung 'laptop sinh viên' không có model -> 'sinh viên'
    - Nếu không có từ khóa đặc trưng -> null>"
  }

  Chú ý: Phải phân biệt rõ ràng giữa "minPrice" (Ví dụ: trên 30 triệu) và "maxPrice" (Ví dụ: dưới 30 triệu). Nếu người dùng nói khoảng giá (Ví dụ: "từ 15 đến 20 triệu") thì điền cả hai trường.`
          }]
        })
      });
  
      const groqData = await groqRes.json();
      if (!groqData.choices || !groqData.choices[0]) {
        return res.status(500).json({ success: false, message: "Groq API lỗi" });
      }
  
      const raw = groqData.choices[0].message.content.trim();
      const intent = JSON.parse(raw);
      

      intent.brand = detectedBrand || null;

      const crossCategoryTypes = ['chuột', 'bàn phím', 'tai nghe', 'loa', 'microphone', 'tay cầm'];
      const crossMatch = crossCategoryTypes.find(t => query.toLowerCase().includes(t));

      if (crossMatch) {

        const crossFilter = { Status: "on_sale", Product_name: { $regex: crossMatch, $options: 'i' } };
        let crossProducts = await Product.find(crossFilter).lean();
        
        crossProducts = await Promise.all(crossProducts.map(async (p) => {
          const variant = await Product_variant.findOne({ Product_id: p.Product_id, Status: "active" }).sort({ Price: 1 }).lean();
          const originalPrice = variant?.Price || 0;
          const finalPrice = originalPrice - (originalPrice * (p.Discount || 0) / 100);
          return { ...p, min_price: originalPrice, final_price: finalPrice };
        }));

        if (intent.minPrice) crossProducts = crossProducts.filter(p => p.final_price >= intent.minPrice);
        if (intent.maxPrice) crossProducts = crossProducts.filter(p => p.final_price <= intent.maxPrice);
        crossProducts.sort((a, b) => (b.Average_rating || 0) - (a.Average_rating || 0));

        const finalData = crossProducts.slice(0, 6).map(p => ({
          ...p,
          min_price: p.final_price,
          original_price: p.min_price,
          aiTag: "✦ AI đề xuất"
        }));

        console.log(`-> Cross-category search "${crossMatch}": ${finalData.length} sản phẩm`);
        return res.json({ success: true, data: finalData, intent, message: "Thành công" });
      }
      console.log("Intent final phân tích bởi AI:", intent);
  

      const filter = { Status: "on_sale" };
  

      let brandNameApplied = null;
      if (intent.brand) {
        const brandDoc = await Brand.findOne({
          Brand_name: { $regex: intent.brand, $options: "i" }
        }).lean();
        if (brandDoc) {
          filter.Brand_id = brandDoc.Brand_id;
          brandNameApplied = brandDoc.Brand_name;
          console.log("-> Đã thêm lọc theo Hãng:", brandDoc.Brand_name);
        } else {
          filter.Brand_id = "NOT_FOUND";
          console.log("-> Không tìm thấy Hãng trong DB:", intent.brand);
        }
      }
  

      let categoryNameApplied = null;
      if (intent.category && intent.category !== "null") {
        const cat = await Category.findOne({
          Category_name: { $regex: intent.category, $options: "i" }
        }).lean();
        if (cat) {
          filter.Category_id = cat.Category_id;
          categoryNameApplied = cat.Category_name;
          console.log("-> Đã thêm lọc theo Danh mục:", cat.Category_name);
        }
      }
  

      let cleanedKeyword =
        intent.keyword &&
        intent.keyword !== "null"
          ? intent.keyword.trim()
          : null;


      if (cleanedKeyword && intent.brand) {
        cleanedKeyword = cleanedKeyword.replace(
          new RegExp(`\\b${intent.brand}\\b`, "ig"),
          ""
        ).trim();
      }

      const semanticKeywords = [
        "siêu mạnh", "mạnh", "gaming", "đồ họa", "cao cấp",
        "mượt", "nhẹ", "gọn", "đẹp", "pin trâu",
        "học tập", "văn phòng", "chơi game",
        "giá rẻ", "rẻ", "tốt", "phù hợp",
        "bàn phím", "chuột", "tai nghe", "loa", "sạc",
        "phụ kiện", "cáp", "hub", "màn hình",
        "giá rẻ", "rẻ", "tốt", "phù hợp",
        "tai nghe", "loa", "microphone",   
        "chuột gaming", "bàn phím cơ", "tay cầm", "tai nghe gaming",
        "loa bluetooth", "micro", "microphone",
      ];

      const containsOnlySemantic =
        cleanedKeyword &&
        semanticKeywords.some(kw =>
          cleanedKeyword.toLowerCase().includes(kw)
        );


      if (
        cleanedKeyword &&
        !containsOnlySemantic
      ) {

        filter.Product_name = {
          $regex: cleanedKeyword,
          $options: "i"
        };

        console.log(
          "-> Lọc theo keyword:",
          cleanedKeyword
        );

      } else if (
        containsOnlySemantic &&
        (filter.Category_id === 'CAT_005' || filter.Category_id === 'CAT_006')
      ) {
        const accessoryTypes = ['chuột', 'bàn phím', 'tai nghe', 'loa', 'sạc', 'hub', 'cáp', 'màn hình', 'tay cầm', 'microphone'];
        const matchedType = accessoryTypes.find(t => cleanedKeyword?.toLowerCase().includes(t));
        if (matchedType) {
          filter.Product_name = { $regex: matchedType, $options: 'i' };
          console.log("-> Lọc theo loại sản phẩm:", matchedType);
        } else {
          console.log("-> Chỉ lọc theo category");
        }

      } else if (
        containsOnlySemantic &&
        !filter.Category_id
      ) {

        const accessoryTypes = ['chuột', 'bàn phím', 'tai nghe', 'loa', 'sạc', 'hub', 'cáp', 'màn hình', 'tay cầm', 'microphone'];
        const matchedType = accessoryTypes.find(t => cleanedKeyword?.toLowerCase().includes(t));
        if (matchedType) {
          filter.Product_name = { $regex: matchedType, $options: 'i' };
          console.log("-> Tìm cross-category theo loại:", matchedType);
        }
      } else if (
        !cleanedKeyword &&
        !filter.Brand_id &&
        !filter.Category_id
      ) {

        filter.Product_name = {
          $regex: query,
          $options: "i"
        };

        console.log(
          "-> Fallback query"
        );

      } else {

        console.log(
          "-> Chỉ lọc theo brand/category"
        );

      }
      let products = await Product.find(filter).lean();

      if (intent.priority === "performance") {
        products.sort((a, b) => {
          const scoreA =
            (a.Average_rating || 0) * 0.6 +
            (a.Price || 0) * 0.4;

          const scoreB =
            (b.Average_rating || 0) * 0.6 +
            (b.Price || 0) * 0.4;

          return scoreB - scoreA;
        });
      }
      console.log("Mongoose Filter ứng dụng:", JSON.stringify(filter));
      console.log("Số lượng sản phẩm tìm thấy sơ bộ:", products.length);
  

      let results = await Promise.all(products.map(async (p) => {
        const variant = await Product_variant.findOne({ Product_id: p.Product_id, Status: "active" }).sort({ Price: 1 }).lean();
        const originalPrice = variant?.Price || 0;
        

        const discountPercent = p.Discount || 0;
        const finalPrice = originalPrice - (originalPrice * discountPercent / 100);

        return { 
          ...p, 
          min_price: originalPrice, 
          final_price: finalPrice   
        };
      }));
  

      if (intent.minPrice) {
        results = results.filter(p => p.final_price >= intent.minPrice);
        console.log("Số lượng sản phẩm sau khi lọc giá tối thiểu thực tế (>= " + intent.minPrice + "):", results.length);
      }
      if (intent.maxPrice) {
        results = results.filter(p => p.final_price <= intent.maxPrice);
        console.log("Số lượng sản phẩm sau khi lọc giá tối đa thực tế (<= " + intent.maxPrice + "):", results.length);
      }
  

      results.sort((a, b) => (b.Average_rating || 0) - (a.Average_rating || 0));
  

      results = results.map((p) => {
        const {
          final_price,
          min_price,
          ...cleanProduct
        } = p;

        return {
          ...cleanProduct,


          min_price: final_price,


          original_price: min_price,

          aiTag: "✦ AI đề xuất"
        };
      });
  

      const resultLimit = intent.brand ? 4 : intent.category ? 6 : 4;
      const finalData = results.slice(0, resultLimit);


      let responseMessage = "Thành công";
      if (finalData.length === 0) {
        const parts = [];
        if (categoryNameApplied) parts.push(categoryNameApplied);
        if (brandNameApplied) parts.push(`hãng ${brandNameApplied}`);
        if (intent.keyword && intent.keyword !== "null") parts.push(`theo từ khóa "${intent.keyword}"`);
        
        let priceDesc = "";
        if (intent.minPrice && intent.maxPrice) {
          priceDesc = `trong tầm giá từ ${intent.minPrice.toLocaleString('vi-VN')}đ đến ${intent.maxPrice.toLocaleString('vi-VN')}đ`;
        } else if (intent.minPrice) {
          priceDesc = `có giá bán trên ${intent.minPrice.toLocaleString('vi-VN')}đ`;
        } else if (intent.maxPrice) {
          priceDesc = `có giá bán dưới ${intent.maxPrice.toLocaleString('vi-VN')}đ`;
        }

        if (priceDesc) parts.push(priceDesc);

        const subject = parts.join(" ") || "sản phẩm";
        responseMessage = `Rất tiếc, VISTA AI chưa tìm thấy sản phẩm ${subject} tại hệ thống cửa hàng. Bạn vui lòng điều chỉnh lại từ khóa hoặc khoảng giá nhé!`;
      }

      res.json({ 
        success: true, 
        data: finalData, 
        intent,
        message: responseMessage 
      });
  
    } catch (error) {
      console.error("Smart Search error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  };