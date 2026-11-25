import { beforeAll, beforeEach, afterAll, describe, expect, test, jest } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { MongoServerError } from "mongodb";
import { app } from "./app";
import { Customer, Order, RepStock, StockMovement, ReceiptBook, User } from "./models";
import { pushHooks } from "./routes/api.routes";
import { seedBase } from "./test-support";

describe("order contracts", () => {
  let replset: MongoMemoryReplSet;
  let context: Awaited<ReturnType<typeof seedBase>>;
  beforeAll(async () => { replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replset.getUri("richbake-orders-test")); process.env.JWT_ACCESS_SECRET = "test-access-secret"; process.env.JWT_REFRESH_SECRET = "test-refresh-secret"; });
  beforeEach(async () => { context = await seedBase(); pushHooks.sendPush = jest.fn(async () => undefined); });
  afterAll(async () => { await mongoose.disconnect(); await replset.stop(); });

  test("order cancel sends exactly once and push rejection does not fail", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    const created = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000101", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(201);
    await request(app).post(`/api/v1/orders/${created.body.data.id}/cancel`).set("Authorization", `Bearer ${context.repToken}`).send({ reason: "Push test" }).expect(200);
    expect((pushHooks.sendPush as jest.MockedFunction<typeof pushHooks.sendPush>).mock.calls.filter((call) => call[1]?.data?.type === "ORDER_CANCELLED")).toHaveLength(1);
  });

  test("real HTTP cancel retries one transient MongoServerError and calls push once", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    const created = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000102", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }).expect(201);
    const original = Order.findOneAndUpdate.bind(Order);
    let attempts = 0;
    const spy = jest.spyOn(Order, "findOneAndUpdate").mockImplementation((async (...args: any[]) => {
      attempts++;
      if (attempts === 1) {
        const error = new MongoServerError({ message: "forced transient" });
        error.addErrorLabel("TransientTransactionError");
        throw error;
      }
      return original(...args as [any, any, any]);
    }) as any);
    const response = await request(app).post(`/api/v1/orders/${created.body.data.id}/cancel`).set("Authorization", `Bearer ${context.repToken}`).send({ reason: "Retry test" }).expect(200);
    spy.mockRestore();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(response.body.data.status).toBe("CANCELLED");
    expect(await RepStock.findOne({ repId: context.rep._id, productId: context.product._id }).lean()).toMatchObject({ quantity: 5 });
    expect((pushHooks.sendPush as jest.MockedFunction<typeof pushHooks.sendPush>).mock.calls.filter((call) => call[1]?.data?.type === "ORDER_CANCELLED")).toHaveLength(1);
  });

  test("two simultaneous orders for the last loaf allow one and reject the other", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 1 });
    const body = (clientId: string) => ({ clientId, customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] });
    const responses = await Promise.all([
      request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send(body("00000000-0000-4000-8000-000000000501")),
      request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send(body("00000000-0000-4000-8000-000000000502")),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
  });

  test("same clientId replay returns the stored order and header", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    const body = { clientId: "00000000-0000-4000-8000-000000000503", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] };
    const first = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send(body).expect(201);
    const replay = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send(body).expect(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.data.id).toBe(first.body.data.id);
  });

  test("same clientId raced concurrently replays once", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    const body = { clientId: "00000000-0000-4000-8000-000000000504", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] };
    const responses = await Promise.all([
      request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send(body),
      request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send(body),
    ]);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
  });

  test("cancelling an order restores rep stock exactly once", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    const created = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000505", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 3 }] }).expect(201);
    await request(app).post(`/api/v1/orders/${created.body.data.id}/cancel`).set("Authorization", `Bearer ${context.repToken}`).send({ reason: "Restore stock" }).expect(200);
    expect((await RepStock.findOne({ repId: context.rep._id, productId: context.product._id }).lean())?.quantity).toBe(5);
    expect(await StockMovement.countDocuments({ type: "CANCEL_RETURN" })).toBe(1);
  });

  test("two simultaneous cancels return one 200 and one 409", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    const created = await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000506", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 2 }] }).expect(201);
    const responses = await Promise.all([
      request(app).post(`/api/v1/orders/${created.body.data.id}/cancel`).set("Authorization", `Bearer ${context.repToken}`).send({ reason: "First" }),
      request(app).post(`/api/v1/orders/${created.body.data.id}/cancel`).set("Authorization", `Bearer ${context.repToken}`).send({ reason: "Second" }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  test("two reps get separate order sequences starting at 0001", async () => {
    const second = await User.create({ role: "rep", name: "Second Rep", phone: "08055555555", repCode: "R002", passwordHash: await bcrypt.hash("Password123", 12), isActive: true });
    const secondCustomer = await Customer.create({ repId: second._id, name: "Second Customer", phone: "08077777777", address: "Second address" });
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    await RepStock.create({ repId: second._id, productId: context.product._id, quantity: 5 });
    const secondToken = jwt.sign({ id: second._id.toString(), role: "rep", name: second.name }, "test-access-secret");
    const responses = await Promise.all([
      request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000507", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }),
      request(app).post("/api/v1/orders").set("Authorization", `Bearer ${secondToken}`).send({ clientId: "00000000-0000-4000-8000-000000000508", customerId: secondCustomer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }] }),
    ]);
    expect(responses[0].body.data.orderNo).toMatch(/^ORD-R001-\d{6}-0001$/);
    expect(responses[1].body.data.orderNo).toMatch(/^ORD-R002-\d{6}-0001$/);
  });

  test("paper receipt number must be in an active book and cannot be reused", async () => {
    await RepStock.create({ repId: context.rep._id, productId: context.product._id, quantity: 5 });
    await ReceiptBook.create({ repId: context.rep._id, prefix: "", startNo: 100, endNo: 110, nextNo: 100, status: "ACTIVE", assignedBy: context.admin._id });
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000509", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }], paperReceiptNo: "105" }).expect(201);
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000510", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }], paperReceiptNo: "105" }).expect(422);
    await request(app).post("/api/v1/orders").set("Authorization", `Bearer ${context.repToken}`).send({ clientId: "00000000-0000-4000-8000-000000000511", customerId: context.customer._id.toString(), items: [{ productId: context.product._id.toString(), quantity: 1 }], paperReceiptNo: "999" }).expect(422);
  });
});
