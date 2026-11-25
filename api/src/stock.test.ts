import { beforeAll, beforeEach, afterAll, describe, expect, test } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import { app } from "./app";
import { Product, RepStock } from "./models";
import { seedBase } from "./test-support";

describe("stock contracts", () => {
  let replset: MongoMemoryReplSet;
  let context: Awaited<ReturnType<typeof seedBase>>;
  beforeAll(async () => { replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replset.getUri("richbake-stock-test")); process.env.JWT_ACCESS_SECRET = "test-access-secret"; process.env.JWT_REFRESH_SECRET = "test-refresh-secret"; });
  beforeEach(async () => { context = await seedBase(); });
  afterAll(async () => { await mongoose.disconnect(); await replset.stop(); });

  test("stock/me and stock/reps/:repId have exact stock shapes", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 7 });
    for (const [url, token] of [["/api/v1/stock/me", context.repToken], [`/api/v1/stock/reps/${context.rep._id}`, context.adminToken]] as const) {
      const response = await request(app).get(url).set("Authorization", `Bearer ${token}`).expect(200);
      expect(response.body.data).toMatchObject({ repId: expect.any(String), totalUnits: 7, items: expect.any(Array) });
      expect(response.body.data.items[0]).toMatchObject({ productId: expect.any(String), name: "Sweet Bread", quantity: 7, unitPrice: 150000, isLow: expect.any(Boolean) });
    }
  });

  test("stock/return accepts multiple items", async () => {
    const second = await Product.create({ name: "Milk Bread", unitPrice: 100000, warehouseStock: 10, isActive: true });
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 7 });
    await RepStock.create({ repId: context.rep._id, productId: second._id, quantity: 5 });
    const response = await request(app).post("/api/v1/stock/return").set("Authorization", `Bearer ${context.adminToken}`).send({ repId: context.rep._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 3 }, { productId: second._id.toString(), quantity: 2 }] }).expect(200);
    expect(response.body.data.repStock).toHaveLength(2);
    expect(response.body.data.warehouse).toHaveLength(2);
  });

  test("stock reconciliation remains consistent after issue and sale", async () => {
    await request(app).post("/api/v1/stock/issue").set("Authorization", `Bearer ${context.adminToken}`).send({ repId: context.rep._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 40 }] }).expect(200);
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000401", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 15 }] }).expect(201);
    expect((await Product.findById(context.product._id).lean())?.warehouseStock).toBe(60);
    expect((await RepStock.findOne({ repId: context.rep._id, productId: context.product._id }).lean())?.quantity).toBe(25);
  });

  test("insufficient stock returns 422", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 2 });
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000402", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 3 }] }).expect(422);
  });
});
