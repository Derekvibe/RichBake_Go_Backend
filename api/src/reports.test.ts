import { beforeAll, beforeEach, afterAll, describe, expect, test } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { app } from "./app";
import { Order, RepStock } from "./models";
import { pushHooks } from "./routes/api.routes";
import { seedBase } from "./test-support";
import { jest } from "@jest/globals";

describe("report contracts", () => {
  let replset: MongoMemoryReplSet;
  let context: Awaited<ReturnType<typeof seedBase>>;
  beforeAll(async () => { replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replset.getUri("richbake-report-test")); process.env.JWT_ACCESS_SECRET = "test-access-secret"; process.env.JWT_REFRESH_SECRET = "test-refresh-secret"; });
  beforeEach(async () => { context = await seedBase(); pushHooks.sendPush = jest.fn(async () => undefined); });
  afterAll(async () => { await mongoose.disconnect(); await replset.stop(); });

  test("Lagos 23:30 and 00:30 orders use D and D+1 boundaries", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    const now = new Date();
    const lagosParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (type: string) => lagosParts.find((item) => item.type === type)?.value || "";
    const todayUtc = new Date(Date.UTC(Number(part("year")), Number(part("month")) - 1, Number(part("day"))));
    const yesterday = new Date(todayUtc.getTime() - 86400000);
    const d = yesterday.toISOString().slice(0, 10);
    const dPlusOne = new Date(yesterday.getTime() + 86400000).toISOString().slice(0, 10);
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000301", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }], placedAt: `${d}T22:30:00.000Z` }).expect(201);
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000302", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }], placedAt: `${d}T23:30:00.000Z` }).expect(201);
    const orders = await Order.find({ repId: context.rep._id }).sort({ placedAt: 1 }).lean();
    expect(orders[0].placedHourLagos).toBe(23);
    expect(orders[1].placedHourLagos).toBe(0);
    expect(orders[0].receiptNo).toContain(d.replace(/-/g, "").slice(-6));
    expect(orders[1].receiptNo).toContain(dPlusOne.replace(/-/g, "").slice(-6));
  });

  test("low stock alert fires on the crossing, not on every already-low order", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 11 });
    const sendPushSpy = pushHooks.sendPush as jest.MockedFunction<typeof pushHooks.sendPush>;
    sendPushSpy.mockResolvedValue(undefined);
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000303", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(201);
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000304", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(201);
    const lowStockCalls = sendPushSpy.mock.calls.filter((call) => call[1]?.data?.type === "LOW_STOCK");
    expect(lowStockCalls).toHaveLength(1);
  });

  test("sales totals match a hand-calculated Lagos sample", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000305", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 2 }], placedAt: new Date().toISOString() }).expect(201);
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000306", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }], placedAt: new Date().toISOString() }).expect(201);
    const response = await request(app).get("/api/v1/reports/sales/me").set("Authorization", `Bearer ${context.repToken}`).query({ period: "today" }).expect(200);
    expect(response.body.data.totals.revenue).toBe(450000);
    expect(response.body.data.totals.orders).toBe(2);
    expect(response.body.data.totals.units).toBe(3);
  });
});
