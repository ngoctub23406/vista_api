const assert = require("node:assert/strict");
const test = require("node:test");
const { Product, Product_variant } = require("../models/schema");
const { getProducts } = require("../controllers/admin/product.controller");

test("admin product search matches product names and SKUs, not variant names", async () => {
  const originalCountDocuments = Product.countDocuments;
  const originalFind = Product.find;
  const originalDistinct = Product_variant.distinct;
  let productFilter;
  let variantFilter;

  Product_variant.distinct = async (_field, filter) => {
    variantFilter = filter;
    return [];
  };
  Product.countDocuments = async (filter) => {
    productFilter = filter;
    return 0;
  };
  Product.find = (filter) => {
    productFilter = filter;
    return {
      sort() { return this; },
      skip() { return this; },
      limit() { return this; },
      lean: async () => [],
    };
  };

  const response = {
    json(body) {
      this.body = body;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
  };

  try {
    await getProducts({ query: { keyword: "loa" } }, response);
  } finally {
    Product.countDocuments = originalCountDocuments;
    Product.find = originalFind;
    Product_variant.distinct = originalDistinct;
  }

  const nameSearch = productFilter.$or.find((condition) => condition.Product_name)
    .Product_name;
  assert.equal(nameSearch.test("Loa Bluetooth JBL"), true);
  assert.equal(nameSearch.test("Tai nghe JBL"), false);
  assert.deepEqual(Object.keys(variantFilter), ["Attributes.sku"]);
  assert.equal(response.body.data.total, 0);
});
