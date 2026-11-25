import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Customer, Product, RepStock, StockMovement, User, Counter, Order } from "./models";

export async function seedBase() {
  await Promise.all([
    Customer.deleteMany({}),
    Order.deleteMany({}),
    Product.deleteMany({}),
    RepStock.deleteMany({}),
    StockMovement.deleteMany({}),
    Counter.deleteMany({}),
  ]);
  await User.deleteMany({});
  const admin = await User.create({
    role: "admin",
    name: "Admin",
    phone: "08011111111",
    passwordHash: await bcrypt.hash("Password123", 12),
    mustChangePassword: false,
  });
  const rep = await User.create({
    role: "rep",
    name: "Test Rep",
    phone: "08022222222",
    repCode: "R001",
    area: "Lagos",
    passwordHash: await bcrypt.hash("Password123", 12),
    mustChangePassword: false,
    isActive: true,
  });
  const product = await Product.create({
    name: "Sweet Bread",
    unitPrice: 150000,
    warehouseStock: 100,
    lowStockThreshold: 10,
    isActive: true,
  });
  const customer = await Customer.create({
    repId: rep._id,
    name: "Mama Ngozi",
    phone: "08033333333",
    address: "Test address",
  });
  return {
    admin,
    rep,
    product,
    customer,
    adminToken: jwt.sign({ id: admin._id.toString(), role: "admin", name: admin.name }, "test-access-secret"),
    repToken: jwt.sign({ id: rep._id.toString(), role: "rep", name: rep.name }, "test-access-secret"),
  };
}
