import { beforeAll, beforeEach, afterAll, describe, expect, test } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { app } from "./app";
import { seedBase } from "./test-support";
import bcrypt from "bcryptjs";
import { Customer, Notification, Product, RepStock, User } from "./models";
import { pushHooks } from "./services/push.service";

describe("Audit regressions", () => {
  let replset: MongoMemoryReplSet;
  let context: Awaited<ReturnType<typeof seedBase>>;
  const realSendPush = pushHooks.sendPush;

  beforeAll(async () => {
    replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replset.getUri("richbake-audit-test"));
    process.env.JWT_ACCESS_SECRET = "test-access-secret";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
  });
  beforeEach(async () => {
    context = await seedBase();
    await Notification.deleteMany({});
    pushHooks.sendPush = realSendPush;
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await replset.stop();
  });

  test("malformed ids return 400 instead of crashing the process", async () => {
    const response = await request(app).get("/api/v1/orders/not-an-id").set("Authorization", `Bearer ${context.adminToken}`).expect(400);
    expect(response.body.error.code).toBe("INVALID_ID");
    await request(app).get("/api/v1/users/not-an-id").set("Authorization", `Bearer ${context.adminToken}`).expect(400);
  });

  test("insufficient warehouse stock on issue returns 422, not 500", async () => {
    const response = await request(app).post("/api/v1/stock/issue").set("Authorization", `Bearer ${context.adminToken}`)
      .send({ repId: context.rep._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1000 }] }).expect(422);
    expect(response.body.error.code).toBe("INSUFFICIENT_WAREHOUSE_STOCK");
    await request(app).post("/api/v1/stock/restock").set("Authorization", `Bearer ${context.adminToken}`)
      .send({ productId: context.product._id.toString(), quantity: -5 }).expect(400);
  });

  test("cron jobs are closed when CRON_SECRET is not configured", async () => {
    const previous = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      await request(app).post("/api/v1/internal/jobs/low-stock-check").expect(401);
      await request(app).post("/api/v1/internal/jobs/daily-summary").send({}).expect(401);
    } finally {
      if (previous !== undefined) process.env.CRON_SECRET = previous;
    }
  });

  test("customer and product updates reject protected fields", async () => {
    await request(app).patch(`/api/v1/customers/${context.customer._id}`).set("Authorization", `Bearer ${context.repToken}`)
      .send({ totalSpent: 99999999 }).expect(400);
    await request(app).patch(`/api/v1/customers/${context.customer._id}`).set("Authorization", `Bearer ${context.repToken}`)
      .send({ name: "Mama Ngozi Updated" }).expect(200);
    expect((await Customer.findById(context.customer._id).lean())?.totalSpent).toBe(0);

    await request(app).patch(`/api/v1/products/${context.product._id}`).set("Authorization", `Bearer ${context.adminToken}`)
      .send({ warehouseStock: 999999 }).expect(400);
    expect((await Product.findById(context.product._id).lean())?.warehouseStock).toBe(100);
  });

  test("search terms with regex metacharacters are treated literally", async () => {
    const response = await request(app).get("/api/v1/customers").set("Authorization", `Bearer ${context.repToken}`).query({ q: "(((" }).expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  test("rep preferred-time returns the summary shape the app renders", async () => {
    const response = await request(app).get("/api/v1/reports/customers/preferred-time").set("Authorization", `Bearer ${context.repToken}`).expect(200);
    expect(response.body.data).toMatchObject({ sampleSize: 0, enoughData: false, buckets: expect.any(Object), hours: expect.any(Array) });
  });

  test("admin top customers covers all reps when no repId is given", async () => {
    await Customer.updateOne({ _id: context.customer._id }, { $set: { orderCount: 2, totalSpent: 300000 } });
    const response = await request(app).get("/api/v1/reports/customers/top").set("Authorization", `Bearer ${context.adminToken}`).expect(200);
    expect(response.body.data.items).toHaveLength(1);
  });

  test("sales report counts cancelled orders in the period", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    pushHooks.sendPush = async () => undefined;
    const created = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`)
      .send({ clientId: "00000000-0000-4000-8000-000000000901", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(201);
    await request(app).post(`/api/v1/orders/${created.body.data.id}/cancel`).set("Authorization", `Bearer ${context.repToken}`).send({ reason: "Customer changed mind" }).expect(200);
    const report = await request(app).get("/api/v1/reports/sales/me").set("Authorization", `Bearer ${context.repToken}`).query({ period: "today" }).expect(200);
    expect(report.body.data.totals.cancelledOrders).toBe(1);
  });

  test("in-app notifications are stored even without a registered push token", async () => {
    await pushHooks.sendPush([context.rep._id.toString()], { type: "STOCK_ISSUED", title: "Stock issued", body: "Updated", data: { type: "STOCK_ISSUED", repId: context.rep._id.toString() } });
    const stored = await Notification.find({ userId: context.rep._id }).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ linkType: "rep", linkId: context.rep._id.toString() });
  });

  test("operator objects in request bodies are rejected", async () => {
    await request(app).post("/api/v1/stock/issue").set("Authorization", `Bearer ${context.adminToken}`)
      .send({ repId: { $ne: null }, items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(400);
    await request(app).post("/api/v1/auth/login").send({ phone: { $gt: "" }, password: "Password123" }).expect(400);
  });

  test("a rep with a temporary password must change it before using the API", async () => {
    await User.updateOne({ _id: context.rep._id }, { $set: { mustChangePassword: true } });
    const blocked = await request(app).get("/api/v1/stock/me").set("Authorization", `Bearer ${context.repToken}`).expect(403);
    expect(blocked.body.error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${context.repToken}`).expect(200);
    const changed = await request(app).post("/api/v1/auth/change-password").set("Authorization", `Bearer ${context.repToken}`)
      .send({ currentPassword: "Password123", newPassword: "NewPassword456" }).expect(200);
    await request(app).get("/api/v1/stock/me").set("Authorization", `Bearer ${changed.body.data.accessToken}`).expect(200);
    expect(await bcrypt.compare("NewPassword456", (await User.findById(context.rep._id).lean())!.passwordHash)).toBe(true);
  });

  test("weak temporary passwords are rejected", async () => {
    await request(app).post(`/api/v1/users/${context.rep._id}/reset-password`).set("Authorization", `Bearer ${context.adminToken}`)
      .send({ temporaryPassword: "short" }).expect(400);
  });

  test("dashboard trend always covers seven Lagos days", async () => {
    const response = await request(app).get("/api/v1/reports/dashboard").set("Authorization", `Bearer ${context.adminToken}`).expect(200);
    expect(response.body.data.trend).toHaveLength(7);
    expect(response.body.data.trend[6].date).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date()));
  });

  test("sales series keys use the Lagos calendar day", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    pushHooks.sendPush = async () => undefined;
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`)
      .send({ clientId: "00000000-0000-4000-8000-000000000902", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(201);
    const report = await request(app).get("/api/v1/reports/sales/me").set("Authorization", `Bearer ${context.repToken}`).query({ period: "week" }).expect(200);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
    expect(report.body.data.series.find((row: { key: string }) => row.key === today)).toMatchObject({ orders: 1, revenue: 150000 });
    expect(report.body.data.period.to).toBe(today);
  });
});
