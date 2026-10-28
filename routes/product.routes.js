const express = require("express");
const router = express.Router();
const productController = require("../controllers/product.controller");


router.get("/categories", productController.getAllCategories);

router.get("/brands", productController.getAllBrands);

router.get("/featured", productController.getFeaturedProducts);


router.get("/flash-sale", productController.getFlashSaleProducts);


router.get("/ai-suggest", productController.getAISuggestedProducts);


router.post("/smart-search", productController.smartSearch);


router.get("/", productController.getAllProducts);


router.get("/category/:categoryId", productController.getProductsByCategory);


router.get('/compare', productController.compareProducts);


router.get("/:id/related", productController.getRelatedProducts);


router.get("/:id", productController.getProductById);

module.exports = router;