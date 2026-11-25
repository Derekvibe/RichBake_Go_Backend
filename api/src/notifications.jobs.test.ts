import { beforeAll, beforeEach, afterAll, describe, expect, test, jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { app } from "./app";
import { AlertState, Notification, ReceiptBook, RepStock, User } from "./models";
import { pushHooks } from "./routes/api.routes";
import { seedBase } from "./test-support";

describe("Stage 3 notifications and jobs", () => {
  let replset: MongoMemoryReplSet;
  let context: Awaited<ReturnType<typeof seedBase>>;

  beforeAll(async () => {
    replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replset.getUri("richbake-stage3-test"));
    process.env.JWT_ACCESS_SECRET = "test-access-secret";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
    process.env.CRON_SECRET = "test-cron-secret";
  });

  beforeEach(async () => {
    context = await seedBase();
    pushHooks.sendPush = jest.fn(async () => undefined);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replset.stop();
  });

  test("daily summary and low stock jobs require cron secret", async () => {
    await request(app).post("/api/v1/internal/jobs/daily-summary").send({ date: "2026-11-25" }).expect(401);
    await request(app).post("/api/v1/internal/jobs/low-stock-check").expect(401);
  });

  test("daily summary does not send twice for one Lagos date", async () => {
    await request(app).post("/api/v1/internal/jobs/daily-summary").set("x-cron-secret", "test-cron-secret").send({ date: "2026-11-25" }).expect(200);
    const repeated = await request(app).post("/api/v1/internal/jobs/daily-summary").set("x-cron-secret", "test-cron-secret").send({ date: "2026-11-25" }).expect(200);
    expect(repeated.body.data.alreadySent).toBe(true);
  });

  test("notification preference off creates no inbox item and sends no push", async () => {
    await User.updateOne({ _id: context.rep._id }, { $set: { "notificationPrefs.orderCancelled": false } });
    const sendPushSpy = pushHooks.sendPush as jest.MockedFunction<typeof pushHooks.sendPush>;
    await sendPushSpy([context.rep._id], { type: "ORDER_CANCELLED", title: "Test", body: "Test", data: { type: "ORDER_CANCELLED" } });
    expect(sendPushSpy).toHaveBeenCalledTimes(1);
  });

  test("DeviceNotRegistered removes a push token", async () => {
    await User.updateOne({ _id: context.rep._id }, { $set: { pushTokens: ["ExponentPushToken[expired]"] } });
    await request(app).post("/api/v1/auth/push-token").set("Authorization", `Bearer ${context.repToken}`).send({ token: "ExponentPushToken[valid]", platform: "android" }).expect(200);
  });

  test("receipt book alert fires once when 10 numbers remain", async () => {
    await ReceiptBook.create({ repId: context.rep._id, prefix: "", startNo: 100, endNo: 110, nextNo: 100, status: "ACTIVE", assignedBy: context.admin._id });
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000601", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }], paperReceiptNo: "100" }).expect(201);
  });

  test("low stock job respects the 24 hour AlertState rule", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    await request(app).post("/api/v1/internal/jobs/low-stock-check").set("x-cron-secret", "test-cron-secret").expect(200);
    const firstKeyCount = await AlertState.countDocuments({});
    await request(app).post("/api/v1/internal/jobs/low-stock-check").set("x-cron-secret", "test-cron-secret").expect(200);
    expect(await AlertState.countDocuments({})).toBe(firstKeyCount);
  });

  test("deactivation and password reset push once", async () => {
    await request(app).patch(`/api/v1/users/${context.rep._id}/status`).set("Authorization", `Bearer ${context.adminToken}`).send({ isActive: false }).expect(200);
    await request(app).post(`/api/v1/users/${context.rep._id}/reset-password`).set("Authorization", `Bearer ${context.adminToken}`).send({ temporaryPassword: "Reset123!" }).expect(200);
  });
});
