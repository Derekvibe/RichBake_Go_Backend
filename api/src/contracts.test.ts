import { beforeAll, beforeEach, afterAll, describe, expect, test } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { app } from "./app";
import { seedBase } from "./test-support";
import { RepStock, StockMovement } from "./models";

describe("Stage 1 contracts", () => {
  let replset: MongoMemoryReplSet;
  let context: Awaited<ReturnType<typeof seedBase>>;
  beforeAll(async () => { replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replset.getUri("richbake-contract-test")); process.env.JWT_ACCESS_SECRET = "test-access-secret"; process.env.JWT_REFRESH_SECRET = "test-refresh-secret"; });
  beforeEach(async () => { context = await seedBase(); });
  afterAll(async () => { await mongoose.disconnect(); await replset.stop(); });

  test("every list endpoint returns data array and meta", async () => {
    const cases = [
      ["/api/v1/users", context.adminToken],
      ["/api/v1/products", context.repToken],
      ["/api/v1/customers", context.repToken],
      ["/api/v1/orders", context.repToken],
      ["/api/v1/orders/cancelled", context.adminToken],
      ["/api/v1/notifications", context.repToken],
      ["/api/v1/receipt-books", context.adminToken],
      ["/api/v1/stock/movements", context.adminToken],
    ] as const;
    for (const [url, token] of cases) {
      const response = await request(app).get(url).set("Authorization", `Bearer ${token}`).query({ limit: 500 }).expect(200);
      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.meta.limit).toBe(100);
      expect(response.body.meta).toMatchObject({ page: 1, limit: 100, total: expect.any(Number), totalPages: expect.any(Number) });
    }
  });

  test("GET /users filters and include=summary", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 7 });
    const response = await request(app).get("/api/v1/users").set("Authorization", `Bearer ${context.adminToken}`).query({ status: "active", area: "Lagos", q: "Test", include: "summary", page: 1, limit: 20 }).expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0]).toMatchObject({ todayRevenue: expect.any(Number), todayOrders: expect.any(Number), stockUnits: 7 });
  });

  test("GET /orders applies q, date, customerId and status filters", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 10 });
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000201", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(201);
    for (const query of [{ q: "ORD-" }, { q: "RB-" }, { q: "Mama Ngozi" }, { from: "2026-11-25", to: "2026-11-25" }, { customerId: context.customer._id.toString() }, { status: "COMPLETED" }]) {
      const response = await request(app).get("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).query(query).expect(200);
      expect(Array.isArray(response.body.data)).toBe(true);
    }
  });

  test("GET /customers/:id returns at most 10 recentOrders", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 20 });
    for (let i = 0; i < 12; i++) {
      await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(201);
    }
    const response = await request(app).get(`/api/v1/customers/${context.customer._id}`).set("Authorization", `Bearer ${context.repToken}`).expect(200);
    expect(response.body.data.recentOrders.length).toBeLessThanOrEqual(10);
  });

  test("receipt, cancelled receipt and cancelled list shapes", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    const created = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000202", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(201);
    const receipt = await request(app).get(`/api/v1/orders/${created.body.data.id}/receipt`).set("Authorization", `Bearer ${context.repToken}`).expect(200);
    expect(receipt.body.data).toMatchObject({ receiptNo: expect.any(String), status: "COMPLETED", business: expect.any(Object), rep: expect.any(Object), customer: expect.any(Object), items: expect.any(Array), total: expect.any(Number), placedAt: expect.any(String) });
    await request(app).post(`/api/v1/orders/${created.body.data.id}/cancel`).set("Authorization", `Bearer ${context.repToken}`).send({ reason: "Contract cancellation" }).expect(200);
    const cancelled = await request(app).get(`/api/v1/orders/${created.body.data.id}/receipt`).set("Authorization", `Bearer ${context.repToken}`).expect(200);
    expect(cancelled.body.data.status).toBe("CANCELLED");
    expect(cancelled.body.data.cancelledAt).toBeDefined();
  });

  test("leaderboard ties and top-customer repId security", async () => {
    const response = await request(app).get("/api/v1/reports/leaderboard/reps").set("Authorization", `Bearer ${context.adminToken}`).query({ period: "month", metric: "revenue", limit: 10 }).expect(200);
    expect(response.body.data).toMatchObject({ period: expect.any(String), metric: "revenue", items: expect.any(Array) });
    await request(app).get("/api/v1/reports/customers/top").set("Authorization", `Bearer ${context.repToken}`).query({ repId: context.admin._id.toString() }).expect(403);
  });

  test("_id and __v guard covers receipt, list, cancel and report responses", async () => {
    await request(app).post("/api/v1/receipt-books").set("Authorization", `Bearer ${context.adminToken}`).send({ repId: context.rep._id.toString(), startNo: 1, endNo: 100 }).expect(201);
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 3 });
    await StockMovement.create({ type: "ISSUE_TO_REP", productId: context.product._id, repId: context.rep._id, quantity: 3, performedBy: context.admin._id });
    const urls = [
      ["/api/v1/receipt-books", context.adminToken],
      ["/api/v1/stock/movements", context.adminToken],
      ["/api/v1/orders/cancelled", context.adminToken],
      ["/api/v1/reports/dashboard", context.adminToken],
      ["/api/v1/reports/home/me", context.repToken],
      ["/api/v1/reports/leaderboard/reps", context.adminToken],
      ["/api/v1/reports/customers/top", context.repToken],
      ["/api/v1/reports/products/top", context.adminToken],
      ["/api/v1/reports/sales/me", context.repToken],
    ] as const;
    for (const [url, token] of urls) {
      const response = await request(app).get(url).set("Authorization", `Bearer ${token}`).expect(200);
      const guard = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(guard); return; }
        if (!value || typeof value !== "object") return;
        for (const [key, nested] of Object.entries(value)) {
          expect(key).not.toBe("_id");
          expect(key).not.toBe("__v");
          guard(nested);
        }
      };
      guard(response.body);
    }
  });
});
