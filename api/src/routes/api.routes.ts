import express from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { loginSchema, createRepSchema, productSchema, customerSchema, createOrderSchema } from "@richbake/shared";
import { Customer, Notification, Order, Product, ReceiptBook, RepStock, StockMovement, User } from "../models";
import { auth, requireRole, validateBody } from "../middleware/auth.middleware";

export const apiRouter = express.Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const accessSecret = () => {
  if (!process.env.JWT_ACCESS_SECRET) throw new Error("JWT_ACCESS_SECRET is required");
  return process.env.JWT_ACCESS_SECRET;
};
const refreshSecret = () => {
  if (!process.env.JWT_REFRESH_SECRET) throw new Error("JWT_REFRESH_SECRET is required");
  return process.env.JWT_REFRESH_SECRET;
};
const envelope = (data: unknown) => ({ success: true, data, error: null });
const productUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype));
  },
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

apiRouter.post("/api/v1/auth/login", loginLimiter, validateBody(loginSchema), async (req, res) => {
  const user = await User.findOne({ phone: req.body.phone }).lean();
  if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash as string)) || !user.isActive) {
    return res.status(401).json({ success: false, data: null, error: { code: "INVALID_CREDENTIALS", message: "Phone or password is incorrect" } });
  }
  const payload = { id: user._id.toString(), role: user.role, name: user.name };
  const accessToken = jwt.sign(payload, accessSecret(), { expiresIn: "15m" });
  const refreshToken = jwt.sign(payload, refreshSecret(), { expiresIn: "30d" });
  await User.updateOne({ _id: user._id }, { refreshTokenHash: await bcrypt.hash(refreshToken, 10) });
  res.json(envelope({ accessToken, refreshToken, user: { id: user._id, role: user.role, name: user.name, mustChangePassword: user.mustChangePassword } }));
});

apiRouter.post("/api/v1/auth/refresh", async (req, res) => {
  try {
    const decoded = jwt.verify(req.body.refreshToken, refreshSecret()) as { id: string; role: "admin" | "rep"; name: string };
    const user = await User.findById(decoded.id);
    if (!user || !user.refreshTokenHash || !(await bcrypt.compare(req.body.refreshToken, user.refreshTokenHash))) throw new Error("invalid");
    const accessToken = jwt.sign({ id: decoded.id, role: decoded.role, name: decoded.name }, accessSecret(), { expiresIn: "15m" });
    res.json(envelope({ accessToken }));
  } catch {
    res.status(401).json({ success: false, data: null, error: { code: "INVALID_REFRESH_TOKEN", message: "Please log in again" } });
  }
});

apiRouter.post("/api/v1/auth/logout", auth, async (req, res) => {
  await User.updateOne({ _id: req.auth!.id }, { $unset: { refreshTokenHash: 1 } });
  res.json(envelope({ loggedOut: true }));
});

apiRouter.post("/api/v1/auth/change-password", auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return res.status(400).json({ success: false, data: null, error: { code: "WEAK_PASSWORD", message: "Use at least 8 characters" } });
  }
  const user = await User.findById(req.auth!.id);
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(400).json({ success: false, data: null, error: { code: "INVALID_PASSWORD", message: "Current password is incorrect" } });
  }
  await User.updateOne({ _id: user._id }, { passwordHash: await bcrypt.hash(newPassword, 12), mustChangePassword: false });
  res.json(envelope({ changed: true }));
});

apiRouter.post("/api/v1/auth/push-token", auth, async (req, res) => {
  if (typeof req.body.token !== "string" || !req.body.token) {
    return res.status(400).json({ success: false, data: null, error: { code: "INVALID_TOKEN", message: "Expo push token is required" } });
  }
  await User.updateOne({ _id: req.auth!.id }, { $addToSet: { pushTokens: req.body.token } });
  res.json(envelope({ registered: true }));
});

apiRouter.get("/api/v1/notifications", auth, async (req, res) => {
  const notifications = await Notification.find({ userId: req.auth!.id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json(envelope(notifications));
});

apiRouter.patch("/api/v1/notifications/:id/read", auth, async (req, res) => {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.auth!.id }, { readAt: new Date() }, { new: true });
  if (!notification) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Notification not found" } });
  res.json(envelope(notification));
});

apiRouter.post("/api/v1/users", auth, requireRole("admin"), validateBody(createRepSchema), async (req, res) => {
  const count = await User.countDocuments({ role: "rep" });
  const repCode = `R${String(count + 1).padStart(3, "0")}`;
  const user = await User.create({
    ...req.body,
    repCode,
    role: "rep",
    passwordHash: await bcrypt.hash(req.body.temporaryPassword, 12),
  });
  res.status(201).json(envelope({ id: user._id, repCode, name: user.name, phone: user.phone }));
});

apiRouter.get("/api/v1/users", auth, requireRole("admin"), async (_req, res) => {
  const users = await User.find({ role: "rep" }).select("-passwordHash -refreshTokenHash").lean();
  res.json(envelope(users));
});

apiRouter.patch("/api/v1/users/:id/status", auth, requireRole("admin"), async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, { isActive: req.body.isActive }, { new: true }).select("-passwordHash");
  res.json(envelope(user));
});

apiRouter.get("/api/v1/users/:id", auth, requireRole("admin"), async (req, res) => {
  const user = await User.findById(req.params.id).select("-passwordHash -refreshTokenHash").lean();
  if (!user) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Rep not found" } });
  const stock = await RepStock.find({ repId: user._id }).populate("productId", "name unitPrice").lean();
  res.json(envelope({ ...user, stock }));
});

apiRouter.patch("/api/v1/users/:id", auth, requireRole("admin"), async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, {
    name: req.body.name,
    phone: req.body.phone,
    vehicleReg: req.body.vehicleReg,
    driverName: req.body.driverName,
    area: req.body.area,
  }, { new: true, runValidators: true }).select("-passwordHash -refreshTokenHash");
  if (!user) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Rep not found" } });
  res.json(envelope(user));
});

apiRouter.post("/api/v1/users/:id/reset-password", auth, requireRole("admin"), async (req, res) => {
  const temporaryPassword = req.body.temporaryPassword;
  if (typeof temporaryPassword !== "string" || temporaryPassword.length < 6) {
    return res.status(400).json({ success: false, data: null, error: { code: "INVALID_PASSWORD", message: "Temporary password must have at least 6 characters" } });
  }
  await User.findByIdAndUpdate(req.params.id, { passwordHash: await bcrypt.hash(temporaryPassword, 12), mustChangePassword: true, refreshTokenHash: undefined });
  res.json(envelope({ reset: true }));
});

apiRouter.post("/api/v1/products", auth, requireRole("admin"), productUpload.single("picture"), async (req, res) => {
  const unitPrice = Number(req.body.unitPrice);
  const parsed = productSchema.safeParse({ name: req.body.name, unitPrice });
  if (!parsed.success) return res.status(400).json({ success: false, data: null, error: { code: "VALIDATION_ERROR", message: "Invalid product details", details: parsed.error.flatten() } });
  let imageUrl: string | undefined;
  let imagePublicId: string | undefined;
  if (req.file) {
    if (!process.env.CLOUDINARY_CLOUD_NAME) return res.status(503).json({ success: false, data: null, error: { code: "IMAGE_UPLOAD_DISABLED", message: "Cloudinary configuration is missing" } });
    const uploaded = await new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "richbake/products", transformation: [{ width: 800, height: 800, crop: "limit" }, { quality: "auto" }] },
        (error, result) => error || !result ? reject(error) : resolve({ secure_url: result.secure_url, public_id: result.public_id }),
      );
      stream.end(req.file!.buffer);
    });
    imageUrl = uploaded.secure_url;
    imagePublicId = uploaded.public_id;
  }
  const product = await Product.create({ ...parsed.data, imageUrl, imagePublicId });
  res.status(201).json(envelope(product));
});

apiRouter.get("/api/v1/products", auth, async (_req, res) => {
  res.json(envelope(await Product.find({ isActive: true }).sort({ name: 1 }).lean()));
});

apiRouter.patch("/api/v1/products/:id", auth, requireRole("admin"), async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!product) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Product not found" } });
  res.json(envelope(product));
});

apiRouter.patch("/api/v1/products/:id/status", auth, requireRole("admin"), async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: req.body.isActive }, { new: true });
  if (!product) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Product not found" } });
  res.json(envelope(product));
});

apiRouter.post("/api/v1/stock/restock", auth, requireRole("admin"), async (req, res) => {
  const { productId, quantity, note } = req.body;
  if (!Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ success: false, data: null, error: { code: "INVALID_QUANTITY", message: "Quantity must be positive" } });
  await Product.updateOne({ _id: productId }, { $inc: { warehouseStock: quantity } });
  await StockMovement.create({ type: "RESTOCK", productId, quantity, performedBy: req.auth!.id, note });
  res.json(envelope(await Product.findById(productId)));
});

apiRouter.post("/api/v1/stock/issue", auth, requireRole("admin"), async (req, res) => {
  const { repId, productId, quantity, note } = req.body;
  if (!Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ success: false, data: null, error: { code: "INVALID_QUANTITY", message: "Quantity must be positive" } });
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const moved = await Product.updateOne({ _id: productId, warehouseStock: { $gte: quantity } }, { $inc: { warehouseStock: -quantity } }, { session });
    if (moved.modifiedCount !== 1) throw Object.assign(new Error("Insufficient warehouse stock"), { code: "INSUFFICIENT_WAREHOUSE_STOCK" });
    await RepStock.updateOne({ repId, productId }, { $inc: { quantity } }, { upsert: true, session });
    await StockMovement.create([{ type: "ISSUE_TO_REP", productId, repId, quantity, performedBy: req.auth!.id, note }], { session });
    await session.commitTransaction();
    res.json(envelope({ issued: quantity }));
  } catch (error: any) {
    await session.abortTransaction();
    res.status(400).json({ success: false, data: null, error: { code: error.code || "STOCK_ERROR", message: error.message } });
  } finally {
    session.endSession();
  }
});

apiRouter.post("/api/v1/stock/return", auth, requireRole("admin"), async (req, res) => {
  const { repId, productId, quantity, note } = req.body;
  if (!Number.isInteger(quantity) || quantity <= 0) return res.status(400).json({ success: false, data: null, error: { code: "INVALID_QUANTITY", message: "Quantity must be positive" } });
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const moved = await RepStock.updateOne({ repId, productId, quantity: { $gte: quantity } }, { $inc: { quantity: -quantity } }, { session });
    if (moved.modifiedCount !== 1) throw Object.assign(new Error("Insufficient rep stock"), { code: "INSUFFICIENT_REP_STOCK" });
    await Product.updateOne({ _id: productId }, { $inc: { warehouseStock: quantity } }, { session });
    await StockMovement.create([{ type: "RETURN_TO_WAREHOUSE", productId, repId, quantity, performedBy: req.auth!.id, note }], { session });
    await session.commitTransaction();
    res.json(envelope({ returned: quantity }));
  } catch (error: any) {
    await session.abortTransaction();
    res.status(400).json({ success: false, data: null, error: { code: error.code || "STOCK_ERROR", message: error.message } });
  } finally {
    session.endSession();
  }
});

apiRouter.get("/api/v1/stock/movements", auth, requireRole("admin"), async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const query: any = {};
  if (req.query.repId) query.repId = req.query.repId;
  if (req.query.productId) query.productId = req.query.productId;
  const [items, total] = await Promise.all([
    StockMovement.find(query).populate("productId", "name").populate("repId", "name repCode").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    StockMovement.countDocuments(query),
  ]);
  res.json(envelope({ items, page, limit, total }));
});

apiRouter.get("/api/v1/stock/me", auth, requireRole("rep"), async (req, res) => {
  const stock = await RepStock.find({ repId: req.auth!.id }).populate("productId", "name unitPrice").lean();
  res.json(envelope(stock));
});

apiRouter.get("/api/v1/stock/reps/:repId", auth, requireRole("admin"), async (req, res) => {
  res.json(envelope(await RepStock.find({ repId: req.params.repId }).populate("productId", "name unitPrice").lean()));
});

apiRouter.post("/api/v1/customers", auth, requireRole("rep"), validateBody(customerSchema), async (req, res) => {
  const customer = await Customer.create({ ...req.body, repId: req.auth!.id });
  res.status(201).json(envelope(customer));
});

apiRouter.get("/api/v1/customers", auth, async (req, res) => {
  const query: any = req.auth!.role === "admin" ? {} : { repId: req.auth!.id };
  if (typeof req.query.q === "string") query.name = { $regex: req.query.q, $options: "i" } as any;
  res.json(envelope(await Customer.find(query).sort({ name: 1 }).lean()));
});

apiRouter.get("/api/v1/customers/:id", auth, async (req, res) => {
  const query: any = { _id: req.params.id };
  if (req.auth!.role === "rep") query.repId = req.auth!.id;
  const customer = await Customer.findOne(query).lean();
  if (!customer) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Customer not found" } });
  const orders = await Order.find({ customerId: customer._id }).sort({ placedAt: -1 }).lean();
  res.json(envelope({ customer, orders }));
});

apiRouter.patch("/api/v1/customers/:id", auth, requireRole("rep"), async (req, res) => {
  const customer = await Customer.findOneAndUpdate({ _id: req.params.id, repId: req.auth!.id }, req.body, { new: true, runValidators: true });
  if (!customer) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Customer not found" } });
  res.json(envelope(customer));
});

apiRouter.post("/api/v1/orders", auth, requireRole("rep"), validateBody(createOrderSchema), async (req, res) => {
  const existing = await Order.findOne({ clientId: req.body.clientId });
  if (existing) return res.json(envelope(existing));
  const placedAt = req.body.placedAt ? new Date(req.body.placedAt) : new Date();
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const repId = req.auth!.id;
    const customer = await Customer.findOne({ _id: req.body.customerId, repId }).session(session);
    if (!customer) throw Object.assign(new Error("Customer not found"), { status: 404 });
    const items: any[] = [];
    for (const line of req.body.items) {
      const stock = await RepStock.updateOne({ repId, productId: line.productId, quantity: { $gte: line.qty } }, { $inc: { quantity: -line.qty } }, { session });
      if (stock.modifiedCount !== 1) throw Object.assign(new Error(`Insufficient stock for product ${line.productId}`), { code: "INSUFFICIENT_STOCK" });
      const product = await Product.findById(line.productId).session(session);
      if (!product) throw Object.assign(new Error("Product not found"), { code: "PRODUCT_NOT_FOUND" });
      items.push({ productId: product._id, name: product.name, unitPrice: product.unitPrice, qty: line.qty, lineTotal: product.unitPrice * line.qty });
    }
    const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const rep = await User.findById(repId).session(session);
    const dateKey = placedAt.toISOString().slice(2, 10).replace(/-/g, "");
    const count = await Order.countDocuments({ repId }).session(session);
    const sequence = String(count + 1).padStart(4, "0");
    const orderNo = `RB-${rep?.repCode}-${dateKey}-${sequence}`;
    const lagosHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", hourCycle: "h23" }).format(placedAt));
    const order = await Order.create([{ orderNo, receiptNo: orderNo, clientId: req.body.clientId, repId, customerId: customer._id, items, total, paymentMethod: req.body.paymentMethod, placedAt, placedHourLagos: lagosHour }], { session });
    await StockMovement.insertMany(items.map((item) => ({ type: "SALE", productId: item.productId, repId, quantity: item.qty, orderId: order[0]._id, performedBy: repId })), { session });
    await Customer.updateOne({ _id: customer._id }, { $inc: { orderCount: 1, totalSpent: total }, lastOrderAt: placedAt }, { session });
    await session.commitTransaction();
    res.status(201).json(envelope(order[0]));
  } catch (error: any) {
    await session.abortTransaction();
    res.status(error.status || 400).json({ success: false, data: null, error: { code: error.code || "ORDER_ERROR", message: error.message } });
  } finally {
    session.endSession();
  }
});

apiRouter.get("/api/v1/orders", auth, async (req, res) => {
  const query: any = req.auth!.role === "admin" ? {} : { repId: req.auth!.id };
  if (req.query.repId && req.auth!.role === "admin") query.repId = req.query.repId;
  res.json(envelope(await Order.find(query).populate("customerId", "name phone").sort({ placedAt: -1 }).lean()));
});

apiRouter.get("/api/v1/orders/cancelled", auth, requireRole("admin"), async (_req, res) => {
  res.json(envelope(await Order.find({ status: "CANCELLED" }).populate("repId", "name repCode").populate("customerId", "name phone").sort({ cancelledAt: -1 }).lean()));
});

apiRouter.get("/api/v1/orders/:id", auth, async (req, res) => {
  const query: any = { _id: req.params.id };
  if (req.auth!.role === "rep") query.repId = req.auth!.id;
  const order = await Order.findOne(query).populate("repId", "name repCode").populate("customerId", "name phone address").lean();
  if (!order) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Order not found" } });
  res.json(envelope(order));
});

apiRouter.get("/api/v1/orders/:id/receipt", auth, async (req, res) => {
  const query: any = { _id: req.params.id };
  if (req.auth!.role === "rep") query.repId = req.auth!.id;
  const order = await Order.findOne(query).populate("repId", "name repCode").populate("customerId", "name phone address").lean();
  if (!order) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Order not found" } });
  res.json(envelope({ businessName: process.env.BUSINESS_NAME || "RichBake", receiptNo: order.receiptNo, status: order.status, rep: order.repId, customer: order.customerId, items: order.items, total: order.total, placedAt: order.placedAt }));
});

apiRouter.post("/api/v1/orders/:id/cancel", auth, async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Order not found" } });
  if (req.auth!.role !== "admin" && order.repId.toString() !== req.auth!.id) return res.status(403).json({ success: false, data: null, error: { code: "FORBIDDEN", message: "Not your order" } });
  if (req.auth!.role !== "admin" && Date.now() - order.placedAt.getTime() > 24 * 60 * 60 * 1000) return res.status(400).json({ success: false, data: null, error: { code: "CANCEL_WINDOW_EXPIRED", message: "24-hour cancellation window has expired" } });
  if (!req.body.reason) return res.status(400).json({ success: false, data: null, error: { code: "REASON_REQUIRED", message: "A cancellation reason is required" } });
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    for (const item of order.items) await RepStock.updateOne({ repId: order.repId, productId: item.productId }, { $inc: { quantity: item.qty } }, { upsert: true, session });
    await StockMovement.insertMany(order.items.map((item) => ({ type: "CANCEL_RETURN", productId: item.productId, repId: order.repId, quantity: item.qty, orderId: order._id, performedBy: req.auth!.id, note: req.body.reason })), { session });
    order.status = "CANCELLED"; order.cancelledAt = new Date(); order.cancelReason = req.body.reason; order.cancelledBy = new mongoose.Types.ObjectId(req.auth!.id);
    await order.save({ session });
    await Customer.updateOne({ _id: order.customerId }, { $inc: { orderCount: -1, totalSpent: -order.total } }, { session });
    await session.commitTransaction();
    res.json(envelope(order));
  } catch (error: any) {
    await session.abortTransaction();
    res.status(500).json({ success: false, data: null, error: { code: "CANCEL_FAILED", message: error.message } });
  } finally {
    session.endSession();
  }
});

apiRouter.post("/api/v1/receipt-books", auth, requireRole("admin"), async (req, res) => {
  const { repId, startNo, endNo } = req.body;
  if (!Number.isInteger(startNo) || !Number.isInteger(endNo) || endNo < startNo) {
    return res.status(400).json({ success: false, data: null, error: { code: "INVALID_RANGE", message: "Enter a valid receipt number range" } });
  }
  const overlap = await ReceiptBook.findOne({ status: "ACTIVE", startNo: { $lte: endNo }, endNo: { $gte: startNo } });
  if (overlap) return res.status(409).json({ success: false, data: null, error: { code: "OVERLAPPING_BLOCK", message: "Receipt block overlaps another active block" } });
  const book = await ReceiptBook.create({ repId, startNo, endNo, nextNo: startNo, assignedBy: req.auth!.id });
  res.status(201).json(envelope(book));
});

apiRouter.get("/api/v1/receipt-books", auth, requireRole("admin"), async (req, res) => {
  const query: any = {};
  if (req.query.repId) query.repId = req.query.repId;
  res.json(envelope(await ReceiptBook.find(query).populate("repId", "name repCode").sort({ assignedAt: -1 }).lean()));
});

apiRouter.get("/api/v1/receipt-books/me", auth, requireRole("rep"), async (req, res) => {
  const books = await ReceiptBook.find({ repId: req.auth!.id, status: "ACTIVE" }).sort({ nextNo: 1 }).lean();
  res.json(envelope(books));
});

apiRouter.patch("/api/v1/receipt-books/:id/void", auth, requireRole("admin"), async (req, res) => {
  const book = await ReceiptBook.findByIdAndUpdate(req.params.id, { status: "VOIDED", voidReason: req.body.reason || "Voided by admin" }, { new: true });
  if (!book) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Receipt block not found" } });
  res.json(envelope(book));
});

apiRouter.get("/api/v1/reports/sales/overview", auth, requireRole("admin"), async (_req, res) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const orders = await Order.aggregate([
    { $match: { status: "COMPLETED", placedAt: { $gte: start } } },
    { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
  ]);
  res.json(envelope({ revenue: orders[0]?.revenue || 0, orders: orders[0]?.orders || 0 }));
});

apiRouter.get("/api/v1/reports/sales/me", auth, requireRole("rep"), async (req, res) => {
  const period = String(req.query.period || "day");
  const units: Record<string, string> = { day: "day", week: "week", month: "month", year: "year" };
  const data = await Order.aggregate([
    { $match: { repId: new mongoose.Types.ObjectId(req.auth!.id), status: "COMPLETED" } },
    { $group: { _id: { $dateTrunc: { date: "$placedAt", unit: units[period] || "day", timezone: "Africa/Lagos" } }, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  res.json(envelope(data));
});

apiRouter.get("/api/v1/reports/sales/reps/:repId", auth, requireRole("admin"), async (req, res) => {
  const period = String(req.query.period || "day");
  const units: Record<string, string> = { day: "day", week: "week", month: "month", year: "year" };
  const data = await Order.aggregate([
    { $match: { repId: new mongoose.Types.ObjectId(String(req.params.repId)), status: "COMPLETED" } },
    { $group: { _id: { $dateTrunc: { date: "$placedAt", unit: units[period] || "day", timezone: "Africa/Lagos" } }, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  res.json(envelope(data));
});

apiRouter.get("/api/v1/reports/leaderboard/reps", auth, requireRole("admin"), async (req, res) => {
  const period = String(req.query.period || "month");
  const units: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
  const start = new Date(Date.now() - units[period] * 24 * 60 * 60 * 1000);
  const data = await Order.aggregate([
    { $match: { status: "COMPLETED", placedAt: { $gte: start } } },
    { $group: { _id: "$repId", revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
    { $sort: { revenue: -1, orders: -1 } },
    { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "rep" } },
    { $unwind: "$rep" },
    { $project: { repId: "$_id", name: "$rep.name", repCode: "$rep.repCode", revenue: 1, orders: 1, _id: 0 } },
  ]);
  res.json(envelope(data));
});

apiRouter.get("/api/v1/reports/customers/top", auth, requireRole("rep"), async (req, res) => {
  const customers = await Customer.find({ repId: req.auth!.id }).sort({ totalSpent: -1 }).limit(10).lean();
  res.json(envelope(customers));
});

apiRouter.get("/api/v1/reports/customers/:id/preferred-time", auth, requireRole("rep"), async (req, res) => {
  const customer = await Customer.findOne({ _id: req.params.id, repId: req.auth!.id });
  if (!customer) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Customer not found" } });
  const hours = await Order.aggregate([
    { $match: { repId: new mongoose.Types.ObjectId(req.auth!.id), customerId: customer._id, status: "COMPLETED" } },
    { $group: { _id: "$placedHourLagos", orders: { $sum: 1 } } },
    { $sort: { orders: -1, _id: 1 } },
  ]);
  res.json(envelope({ minimumOrders: 3, sufficientData: hours.reduce((sum, row) => sum + row.orders, 0) >= 3, hours }));
});

apiRouter.get("/api/v1/reports/customers/preferred-time", auth, requireRole("rep"), async (req, res) => {
  const hours = await Order.aggregate([
    { $match: { repId: new mongoose.Types.ObjectId(req.auth!.id), status: "COMPLETED" } },
    { $group: { _id: "$placedHourLagos", orders: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  res.json(envelope(hours));
});

apiRouter.get("/api/v1/reports/products/top", auth, requireRole("admin"), async (_req, res) => {
  const data = await Order.aggregate([
    { $match: { status: "COMPLETED" } },
    { $unwind: "$items" },
    { $group: { _id: "$items.productId", name: { $first: "$items.name" }, quantity: { $sum: "$items.qty" }, revenue: { $sum: "$items.lineTotal" } } },
    { $sort: { revenue: -1 } },
  ]);
  res.json(envelope(data));
});
