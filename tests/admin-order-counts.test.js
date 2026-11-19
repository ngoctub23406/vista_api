const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config({ path: "D:/VISTA/vista_api/.env.test" });

const orderController = require("../controllers/admin/order.controller");

function mockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

test("Admin Order Counts: Số lượng đếm các tab phải đồng nhất và không bị reset về 0 khi chuyển tab", async (t) => {
  t.after(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI);
  }
  assert.equal(mongoose.connection.name, "vista_test", "Bắt buộc kết nối vista_test");

  // 1. Gọi tab Tất cả ("")
  const reqAll = { query: { status: "", page: 1, limit: 10 }, user: { Role: "Staff" } };
  const resAll = mockResponse();
  await orderController.getOrders(reqAll, resAll);

  assert.equal(resAll.statusCode, 200);
  assert.equal(resAll.body.success, true);
  const dataAll = resAll.body.data;
  assert.ok(dataAll.counts, "Phải có đối tượng counts");
  assert.equal(typeof dataAll.counts.all, "number");
  assert.equal(typeof dataAll.counts.pending_payment, "number");

  // 2. Gọi tab Chờ thanh toán ("pending_payment")
  const reqPending = { query: { status: "pending_payment", page: 1, limit: 10 }, user: { Role: "Staff" } };
  const resPending = mockResponse();
  await orderController.getOrders(reqPending, resPending);

  assert.equal(resPending.statusCode, 200);
  assert.equal(resPending.body.success, true);
  const dataPending = resPending.body.data;

  // Kiểm tra số lượng phân trang của tab Chờ thanh toán
  assert.equal(
    dataPending.total,
    dataAll.counts.pending_payment,
    "Tổng số đơn trong tab Chờ thanh toán phải khớp với số badge pending_payment"
  );
  if (dataPending.items.length > 0) {
    assert.ok(
      dataPending.items.every((item) => item.Display_status === "pending_payment"),
      "Tất cả đơn trong tab Chờ thanh toán phải có Display_status là pending_payment"
    );
  }

  // 3. SO SÁNH QUAN TRỌNG NHẤT: Bảng counts giữa 2 lần gọi phải BẰNG NHAU HOÀN TOÀN
  assert.deepEqual(
    dataPending.counts,
    dataAll.counts,
    "Các số đếm tab counts khi ở tab pending_payment phải giữ nguyên như khi ở tab Tất cả, không được nhảy loạn hay biến về 0"
  );

  // 4. Gọi tab Đang xử lý ("processing")
  const reqProcessing = { query: { status: "processing", page: 1, limit: 10 }, user: { Role: "Staff" } };
  const resProcessing = mockResponse();
  await orderController.getOrders(reqProcessing, resProcessing);

  assert.equal(resProcessing.statusCode, 200);
  const dataProcessing = resProcessing.body.data;

  assert.deepEqual(
    dataProcessing.counts,
    dataAll.counts,
    "Số đếm tab counts khi ở tab processing phải giữ nguyên ổn định 100%"
  );
  assert.equal(
    dataProcessing.total,
    dataAll.counts.processing,
    "Tổng số đơn trong tab Đang xử lý phải khớp với số badge processing"
  );

  // 5. Gọi tab Quá hạn ("overdue")
  const reqOverdue = { query: { status: "overdue", page: 1, limit: 10 }, user: { Role: "Staff" } };
  const resOverdue = mockResponse();
  await orderController.getOrders(reqOverdue, resOverdue);

  assert.equal(resOverdue.statusCode, 200);
  const dataOverdue = resOverdue.body.data;

  assert.deepEqual(
    dataOverdue.counts,
    dataAll.counts,
    "Số đếm tab counts khi ở tab overdue phải giữ nguyên ổn định 100%"
  );
  assert.equal(
    dataOverdue.total,
    dataAll.counts.overdue,
    "Tổng số đơn trong tab Quá hạn phải khớp với số badge overdue"
  );
});
