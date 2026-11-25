import { beforeAll, beforeEach, afterAll, describe, expect, test } from "@jest/globals";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import bcrypt from "bcryptjs";
import { app } from "./app";
import { Customer, Order, Product, RepStock, User } from "./models";
import { seedBase } from "./test-support";

describe("auth contracts", () => {
  let replset: MongoMemoryReplSet;
  let context: Awaited<ReturnType<typeof seedBase>>;

  beforeAll(async () => {
    replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replset.getUri("richbake-auth-test"));
    process.env.JWT_ACCESS_SECRET = "test-access-secret";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret";
  });

  beforeEach(async () => { context = await seedBase(); });
  afterAll(async () => { await mongoose.disconnect(); await replset.stop(); });

  test("refresh reuse revokes the session", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ phone: context.rep.phone, password: "Password123" }).expect(200);
    await request(app).post("/api/v1/auth/refresh").send({ refreshToken: login.body.data.refreshToken }).expect(200);
    await request(app).post("/api/v1/auth/refresh").send({ refreshToken: login.body.data.refreshToken }).expect(401);
  });

  test("deactivated rep is rejected on the next request", async () => {
    await User.updateOne({ _id: context.rep._id }, { $set: { isActive: false } });
    await request(app).get("/api/v1/stock/me").set("Authorization", `Bearer ${context.repToken}`).expect(403);
  });

  test("rep cannot read another rep customer or order", async () => {
    const bcryptHash = await bcrypt.hash("Password123", 12);
    const other = await User.create({ role: "rep", name: "Other", phone: "08044444444", repCode: "R002", passwordHash: bcryptHash, isActive: true });
    const customer = await Customer.create({ repId: other._id, name: "Other Customer", phone: "08055555555", address: "Other" });
    await RepStock.create({ repId: other._id, productId: context.product._id, quantity: 3 });
    const order = await Order.create({ orderNo: "ORD-R002-261125-0001", receiptNo: "RB-R002-261125-0001", clientId: "00000000-0000-4000-8000-000000000601", repId: other._id, customerId: customer._id, items: [{ productId: context.product._id, name: context.product.name, unitPrice: 150000, qty: 1, lineTotal: 150000 }], total: 150000, status: "COMPLETED", placedAt: new Date(), placedHourLagos: 10 });
    await request(app).get(`/api/v1/customers/${customer._id}`).set("Authorization", `Bearer ${context.repToken}`).expect(404);
    await request(app).get(`/api/v1/orders/${order._id}`).set("Authorization", `Bearer ${context.repToken}`).expect(404);
  });

  test("rep cannot call admin routes", async () => {
    await request(app).get("/api/v1/users").set("Authorization", `Bearer ${context.repToken}`).expect(403);
  });
});
