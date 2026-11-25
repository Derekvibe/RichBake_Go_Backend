import express from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { Expo } from "expo-server-sdk";
import { loginSchema, createRepSchema, productSchema, customerSchema, createOrderSchema } from "@richbake/shared";
import { AlertState, Counter, Customer, JobRun, Notification, Order, Product, ReceiptBook, RepStock, StockMovement, User } from "../models";
import { auth, requireRole, validateBody } from "../middleware/auth.middleware";
import { ApiError, mapError, runTx } from "../utils/transactions";
import { paginate, toApiObject } from "../utils/response";

export const apiRouter = express.Router();

const expo = new Expo();
async function sendPush(userIds: mongoose.Types.ObjectId[] | string[], message: { type?: string; title: string; body: string; data?: Record<string, unknown> }) {
  const type = message.type || String(message.data?.type || "");
  const users = await User.find({ _id: { $in: userIds }, isActive: true }).lean();
  for (const user of users) {
    const preferenceKey = notificationPreferenceKey(type);
    const prefs = user.notificationPrefs instanceof Map
      ? user.notificationPrefs
      : new Map(Object.entries(user.notificationPrefs || {}));
    if (preferenceKey && prefs.get(preferenceKey) === false) continue;
    const typeNotificationsEnabled = preferenceKey ? prefs.get(preferenceKey) : undefined;
    if (type === "NEW_ORDER" && typeNotificationsEnabled !== true) continue;
    const tokens = (user.pushTokens || []).filter((token) => Expo.isExpoPushToken(token));
    if (!tokens.length) continue;
    await Notification.create({ userId: user._id, type, title: message.title, body: message.body, data: message.data || {}, linkType: String(message.data?.orderId || message.data?.repId || message.data?.productId || ""), linkId: String(message.data?.orderId || message.data?.repId || message.data?.productId || "") });
    for (let index = 0; index < tokens.length; index += 100) {
      const chunk = tokens.slice(index, index + 100);
      const tickets = await expo.sendPushNotificationsAsync(chunk.map((to) => ({ to, sound: "default", title: message.title, body: message.body, data: message.data || {} })));
      tickets.forEach((ticket, ticketIndex) => {
        if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
          void User.updateOne({ _id: user._id }, { $pull: { pushTokens: chunk[ticketIndex] } });
        }
      });
    }
  }
}
export const pushHooks = {
  sendPush,
};

function notificationPreferenceKey(type: string): string | null {
  const keys: Record<string, string> = {
    ORDER_CANCELLED: "orderCancelled",
    STOCK_ISSUED: "stockIssued",
    LOW_STOCK: "lowStock",
    RECEIPT_BOOK_LOW: "receiptBookLow",
    DAILY_SUMMARY: "dailySummary",
    NEW_ORDER: "newOrder",
    ACCOUNT_ALERT: "accountAlerts",
  };
  return keys[type] || null;
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
const accessSecret = () => {
  if (!process.env.JWT_ACCESS_SECRET) throw new Error("JWT_ACCESS_SECRET is required");
  return process.env.JWT_ACCESS_SECRET;
};
const refreshSecret = () => {
  if (!process.env.JWT_REFRESH_SECRET) throw new Error("JWT_REFRESH_SECRET is required");
  return process.env.JWT_REFRESH_SECRET;
};
const envelope = (data: unknown) => ({ success: true, data: toApiObject(data as any), error: null });
function lagosDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { year: Number(value("year")), month: Number(value("month")) - 1, day: Number(value("day")) };
}
function lagosMidnightUtc(date = new Date()) {
  const { year, month, day } = lagosDateParts(date);
  return new Date(Date.UTC(year, month, day, -1, 0, 0, 0));
}
function lagosRange(periodValue: unknown, fromValue: unknown, toValue: unknown) {
  const period = String(periodValue || "month");
  const now = lagosMidnightUtc();
  let from = now;
  let to = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (period === "today") {
    from = now;
  } else if (period === "week") {
    const lagos = lagosDateParts();
    const lagosAsUtc = new Date(Date.UTC(lagos.year, lagos.month, lagos.day));
    const mondayOffset = (lagosAsUtc.getUTCDay() + 6) % 7;
    from = lagosMidnightUtc(new Date(lagosAsUtc.getTime() - mondayOffset * 86400000));
  } else if (period === "month") {
    const lagos = lagosDateParts();
    from = lagosMidnightUtc(new Date(Date.UTC(lagos.year, lagos.month, 1)));
  } else if (period === "year") {
    const lagos = lagosDateParts();
    from = lagosMidnightUtc(new Date(Date.UTC(lagos.year, 0, 1)));
  } else if (period === "custom" && typeof fromValue === "string" && typeof toValue === "string") {
    from = new Date(`${fromValue}T00:00:00.000Z`);
    to = new Date(`${toValue}T23:59:59.999Z`);
  }
  return { period, from, to };
}
const productUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    callback(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype));
  },
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const normalizePhone = (phone: string) =>
  phone.trim().replace(/\s+/g, "").replace(/^\+234/, "0");

const getNextCounter = async (key: string, session?: mongoose.ClientSession) => {
  const counter = await Counter.findOneAndUpdate(
    { key },
    { $inc: { sequence: 1 } },
    { new: true, upsert: true, session },
  );
  return counter.sequence;
};

apiRouter.post("/api/v1/auth/login", loginLimiter, validateBody(loginSchema), async (req, res) => {
  const user = await User.findOne({ phone: normalizePhone(req.body.phone) }).lean();
  if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash as string)) || !user.isActive) {
    return res.status(401).json({ success: false, data: null, error: { code: "INVALID_CREDENTIALS", message: "Phone or password is incorrect" } });
  }
  const payload = { id: user._id.toString(), role: user.role, name: user.name };
  const accessToken = jwt.sign(payload, accessSecret(), { expiresIn: "15m" });
  const refreshToken = jwt.sign({ ...payload, sessionId: crypto.randomUUID() }, refreshSecret(), { expiresIn: "30d" });
  await User.updateOne({ _id: user._id }, {
    refreshTokenHash: await bcrypt.hash(refreshToken, 10),
    refreshTokenSessionId: (jwt.decode(refreshToken) as { sessionId: string }).sessionId,
  });
  res.json(envelope({ accessToken, refreshToken, user: { id: user._id, role: user.role, name: user.name, mustChangePassword: user.mustChangePassword } }));
});

apiRouter.post("/api/v1/auth/refresh", async (req, res) => {
  try {
    const decoded = jwt.verify(req.body.refreshToken, refreshSecret()) as { id: string; role: "admin" | "rep"; name: string; sessionId: string };
    const user = await User.findById(decoded.id);
    if (!user || !user.refreshTokenHash || user.refreshTokenSessionId !== decoded.sessionId || !(await bcrypt.compare(req.body.refreshToken, user.refreshTokenHash))) {
      if (user) await User.updateOne({ _id: user._id }, { $unset: { refreshTokenHash: 1, refreshTokenSessionId: 1 } });
      throw new Error("reuse");
    }
    const payload = { id: decoded.id, role: decoded.role, name: decoded.name };
    const accessToken = jwt.sign(payload, accessSecret(), { expiresIn: "15m" });
    const refreshToken = jwt.sign({ ...payload, sessionId: crypto.randomUUID() }, refreshSecret(), { expiresIn: "30d" });
    await User.updateOne({ _id: user._id }, {
      refreshTokenHash: await bcrypt.hash(refreshToken, 10),
      refreshTokenSessionId: (jwt.decode(refreshToken) as { sessionId: string }).sessionId,
    });
    res.json(envelope({ accessToken, refreshToken }));
  } catch {
    res.status(401).json({ success: false, data: null, error: { code: "INVALID_REFRESH_TOKEN", message: "Please log in again" } });
  }
});

apiRouter.post("/api/v1/auth/logout", auth, async (req, res) => {
  await User.updateOne({ _id: req.auth!.id }, { $unset: { refreshTokenHash: 1 } });
  if (typeof req.body?.refreshToken === "string") {
    await User.updateOne({ _id: req.auth!.id }, { $unset: { refreshTokenHash: 1 } });
  }
  if (typeof req.body?.pushToken === "string") {
    await User.updateOne({ _id: req.auth!.id }, { $pull: { pushTokens: req.body.pushToken } });
  }
  res.json(envelope({ loggedOut: true }));
});

apiRouter.post("/api/v1/auth/change-password", auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof newPassword !== "string" || newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword) || newPassword === currentPassword) {
    return res.status(400).json({ success: false, data: null, error: { code: "VALIDATION_ERROR", message: "Use 8 characters with a letter and number, different from your current password" } });
  }
  const user = await User.findById(req.auth!.id);
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
    return res.status(400).json({ success: false, data: null, error: { code: "INVALID_PASSWORD", message: "Current password is incorrect" } });
  }
  await User.updateOne({ _id: user._id }, { passwordHash: await bcrypt.hash(newPassword, 12), mustChangePassword: false, $unset: { refreshTokenHash: 1, refreshTokenSessionId: 1 } });
  const payload = { id: user._id.toString(), role: user.role, name: user.name };
  const accessToken = jwt.sign(payload, accessSecret(), { expiresIn: "15m" });
  const refreshToken = jwt.sign({ ...payload, sessionId: crypto.randomUUID() }, refreshSecret(), { expiresIn: "30d" });
  await User.updateOne({ _id: user._id }, { refreshTokenHash: await bcrypt.hash(refreshToken, 10), refreshTokenSessionId: (jwt.decode(refreshToken) as { sessionId: string }).sessionId });
  res.json(envelope({ accessToken, refreshToken }));
});

apiRouter.post("/api/v1/auth/push-token", auth, async (req, res) => {
  if (typeof req.body.token !== "string" || !/^ExponentPushToken\[/.test(req.body.token) || !["android", "ios"].includes(req.body.platform)) {
    return res.status(400).json({ success: false, data: null, error: { code: "VALIDATION_ERROR", message: "Invalid push token or platform" } });
  }
  await User.updateMany({ _id: { $ne: req.auth!.id }, pushTokens: req.body.token }, { $pull: { pushTokens: req.body.token } });
  await User.updateOne({ _id: req.auth!.id }, { $addToSet: { pushTokens: req.body.token } });
  res.json(envelope({ registered: true }));
});

apiRouter.get("/api/v1/notifications", auth, async (req, res) => {
  const meta = paginate(req.query.page, req.query.limit, await Notification.countDocuments({ userId: req.auth!.id }));
  const notifications = await Notification.find({ userId: req.auth!.id }).sort({ createdAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  res.json({ success: true, data: toApiObject(notifications as any), meta, error: null });
});

apiRouter.patch("/api/v1/notifications/:id/read", auth, async (req, res) => {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.auth!.id }, { readAt: new Date() }, { new: true });
  if (!notification) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Notification not found" } });
  res.json(envelope(notification));
});

apiRouter.post("/api/v1/users", auth, requireRole("admin"), validateBody(createRepSchema), async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (await User.findOne({ phone })) return res.status(409).json({ success: false, error: { code: "PHONE_EXISTS", message: "Phone already exists" } });
  const count = await getNextCounter("repCode");
  const repCode = `R${String(count).padStart(3, "0")}`;
  const temporaryPassword = req.body.temporaryPassword || Math.random().toString(36).slice(-8).replace(/[^a-zA-Z0-9]/g, "A1").padEnd(8, "A1").slice(0, 8);
  const user = await User.create({
    ...req.body,
    phone,
    repCode,
    role: "rep",
    passwordHash: await bcrypt.hash(temporaryPassword, 12),
  });
  res.status(201).json(envelope({ user: { id: user._id, repCode, name: user.name, phone: user.phone, role: "rep", isActive: true, mustChangePassword: true }, temporaryPassword }));
});

apiRouter.get("/api/v1/users", auth, requireRole("admin"), async (req, res) => {
  const query: any = { role: "rep" };
  if (!req.query.status || req.query.status === "active") query.isActive = true;
  if (req.query.status === "all") delete query.isActive;
  if (req.query.status === "inactive") query.isActive = false;
  if (typeof req.query.area === "string") query.area = req.query.area;
  if (typeof req.query.q === "string") {
    query.$or = [
      { name: { $regex: req.query.q, $options: "i" } },
      { phone: { $regex: req.query.q, $options: "i" } },
      { repCode: { $regex: req.query.q, $options: "i" } },
    ];
  }
  const meta = paginate(req.query.page, req.query.limit, await User.countDocuments(query));
  let users = await User.find(query).select("-passwordHash -refreshTokenHash").sort({ name: 1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  if (req.query.include === "summary") {
    users = await Promise.all(users.map(async (user: any) => {
      const todayStart = lagosMidnightUtc();
      const [sales, stock] = await Promise.all([
        Order.aggregate([
          { $match: { repId: user._id, status: "COMPLETED", placedAt: { $gte: todayStart, $lt: lagosMidnightUtc(new Date(Date.now() + 24 * 60 * 60 * 1000)) } } },
          { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
        ]),
        RepStock.aggregate([
          { $match: { repId: user._id } },
          { $group: { _id: null, stockUnits: { $sum: "$quantity" } } },
        ]),
      ]);
      return { ...user, todayRevenue: sales[0]?.revenue || 0, todayOrders: sales[0]?.orders || 0, stockUnits: stock[0]?.stockUnits || 0 };
    })) as any;
  }
  res.json({ success: true, data: toApiObject(users as any), meta, error: null });
});

apiRouter.patch("/api/v1/users/:id/status", auth, requireRole("admin"), async (req, res) => {
  if (req.params.id === req.auth!.id) return res.status(422).json({ success: false, error: { code: "CANNOT_DEACTIVATE_SELF", message: "You cannot deactivate your own account" } });
  const update: any = { isActive: req.body.isActive };
  if (req.body.isActive === false) update.$unset = { refreshTokenHash: 1, refreshTokenSessionId: 1 };
  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select("-passwordHash");
  if (!user) return res.status(404).json({ success: false, error: { code: "USER_NOT_FOUND", message: "Rep not found" } });
  if (req.body.isActive === false) {
    await Promise.allSettled([
      pushHooks.sendPush([user._id], { type: "ACCOUNT_ALERT", title: "Account deactivated", body: "Your account has been deactivated", data: { type: "ACCOUNT_ALERT", repId: user._id.toString() } }),
    ]);
  }
  res.json(envelope(user));
});

apiRouter.get("/api/v1/users/:id", auth, requireRole("admin"), async (req, res) => {
  const user = await User.findById(req.params.id).select("-passwordHash -refreshTokenHash").lean();
  if (!user) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Rep not found" } });
  const stock = await RepStock.find({ repId: user._id }).populate("productId", "name unitPrice").lean();
  const lagosStart = lagosMidnightUtc();
  const monthStart = lagosMidnightUtc(new Date(Date.UTC(lagosDateParts().year, lagosDateParts().month, 1)));
  const lagosParts = lagosDateParts();
  const lagosUtc = new Date(Date.UTC(lagosParts.year, lagosParts.month, lagosParts.day));
  const mondayOffset = (lagosUtc.getUTCDay() + 6) % 7;
  const mondayStart = lagosMidnightUtc(new Date(lagosUtc.getTime() - mondayOffset * 86400000));
  const [today, week, month, lastOrder] = await Promise.all([
    Order.aggregate([{ $match: { repId: user._id, status: "COMPLETED", placedAt: { $gte: lagosStart } } }, { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { repId: user._id, status: "COMPLETED", placedAt: { $gte: mondayStart } } }, { $group: { _id: null, revenue: { $sum: "$total" } } }]),
    Order.aggregate([{ $match: { repId: user._id, status: "COMPLETED", placedAt: { $gte: monthStart } } }, { $group: { _id: null, revenue: { $sum: "$total" } } }]),
    Order.findOne({ repId: user._id }).sort({ placedAt: -1 }).select("placedAt").lean(),
  ]);
  res.json(envelope({
    ...user,
    stock,
    summary: {
      todayRevenue: today[0]?.revenue || 0,
      todayOrders: today[0]?.orders || 0,
      weekRevenue: week[0]?.revenue || 0,
      monthRevenue: month[0]?.revenue || 0,
      stockUnits: stock.reduce((sum: number, row: any) => sum + row.quantity, 0),
      lastOrderAt: lastOrder?.placedAt || null,
    },
  }));
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
  await Promise.allSettled([
    pushHooks.sendPush([String(req.params.id)], { type: "ACCOUNT_ALERT", title: "Password reset", body: "An administrator reset your password", data: { type: "ACCOUNT_ALERT", repId: String(req.params.id) } }),
  ]);
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

apiRouter.get("/api/v1/products", auth, async (req, res) => {
  const query: any = {};
  if (req.auth!.role === "rep" || req.query.status !== "all") query.isActive = true;
  if (typeof req.query.q === "string") query.name = { $regex: req.query.q, $options: "i" };
  const meta = paginate(req.query.page, req.query.limit, await Product.countDocuments(query));
  const products = await Product.find(query).sort({ name: 1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  const data = await Promise.all(products.map(async (product) => {
    if (req.auth!.role !== "rep") return product;
    const stock = await RepStock.findOne({ repId: req.auth!.id, productId: product._id }).lean();
    return { ...product, myStock: stock?.quantity || 0 };
  }));
  res.json({ success: true, data: toApiObject(data as any), meta, error: null });
});

apiRouter.get("/api/v1/products/:id", auth, async (req, res) => {
  const product = await Product.findById(req.params.id).lean();
  if (!product) return res.status(404).json({ success: false, data: null, error: { code: "PRODUCT_NOT_FOUND", message: "Product not found" } });
  res.json(envelope(product));
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
  const items = Array.isArray(req.body.items)
    ? req.body.items
    : req.body.productId
      ? [{ productId: req.body.productId, quantity: req.body.quantity }]
      : [];
  if (!items.length) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Items are required" } });
  try {
    const movements = await runTx(async (session) => {
    const merged = new Map<string, number>();
    for (const item of items) {
      const quantity = item.quantity ?? item.qty;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw Object.assign(new Error("Quantity must be from 1 to 100000"), { code: "VALIDATION_ERROR", status: 400 });
      merged.set(item.productId, (merged.get(item.productId) || 0) + quantity);
    }
    const movements: any[] = [];
    for (const [productId, quantity] of merged) {
      const product = await Product.findById(productId).session(session);
      if (!product) throw Object.assign(new Error("Product not found"), { code: "PRODUCT_NOT_FOUND", status: 404 });
      if (!product.isActive) throw Object.assign(new Error("Product is inactive"), { code: "PRODUCT_INACTIVE", status: 422 });
      await Product.updateOne({ _id: productId }, { $inc: { warehouseStock: quantity } }, { session });
      movements.push({ type: "RESTOCK", productId, quantity, performedBy: req.auth!.id, note: req.body.note });
    }
    await StockMovement.insertMany(movements, { session });
      return movements;
    });
    res.json(envelope({ movements }));
  } catch (error) {
    const result = mapError(error);
    res.status(result.status).json(result.body);
  }
});

apiRouter.post("/api/v1/stock/issue", auth, requireRole("admin"), async (req, res) => {
  const { repId, note } = req.body;
  const rep = await User.findOne({ _id: repId, role: "rep" });
  if (!rep) return res.status(404).json({ success: false, error: { code: "USER_NOT_FOUND", message: "Rep not found" } });
  if (!rep.isActive) return res.status(422).json({ success: false, error: { code: "ACCOUNT_INACTIVE", message: "Rep account is inactive" } });
  const items = Array.isArray(req.body.items)
    ? req.body.items
    : req.body.productId
      ? [{ productId: req.body.productId, quantity: req.body.quantity }]
      : [];
  if (!items.length) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "items are required" } });
  try {
    const afterCommit: Array<() => Promise<void>> = [];
    const result = await runTx(async (session) => {
    afterCommit.length = 0;
    const mergedItems = new Map<string, number>();
    for (const item of items) {
      const quantity = item.quantity ?? item.qty;
      if (!Number.isInteger(quantity) || quantity < 1) throw Object.assign(new Error("Quantity must be positive"), { code: "VALIDATION_ERROR", status: 400 });
      mergedItems.set(item.productId, (mergedItems.get(item.productId) || 0) + quantity);
    }
    const short: any[] = [];
    for (const [productId, quantity] of mergedItems) {
      const product = await Product.findById(productId).session(session);
      if (!product) throw Object.assign(new Error("Product not found"), { code: "PRODUCT_NOT_FOUND", status: 404 });
      if (!product.isActive) throw Object.assign(new Error("Product is inactive"), { code: "PRODUCT_INACTIVE", status: 422 });
      if (!Number.isInteger(quantity) || quantity <= 0) throw Object.assign(new Error("Quantity must be positive"), { code: "VALIDATION_ERROR", status: 400 });
      if (product.warehouseStock < quantity) short.push({ productId: product._id, requested: quantity, available: product.warehouseStock });
    }
    if (short.length) throw Object.assign(new Error("Insufficient warehouse stock"), { code: "INSUFFICIENT_WAREHOUSE_STOCK", status: 422, details: short });
    const repStock: any[] = [];
    const warehouse: any[] = [];
    for (const [productId, quantity] of mergedItems) {
      const product = await Product.findOneAndUpdate({ _id: productId }, { $inc: { warehouseStock: -quantity } }, { new: true, session });
      await RepStock.updateOne({ repId, productId }, { $inc: { quantity } }, { upsert: true, session });
      await StockMovement.create([{ type: "ISSUE_TO_REP", productId, repId, quantity, performedBy: req.auth!.id, note }], { session });
      repStock.push({ productId, quantity: (await RepStock.findOne({ repId, productId }).session(session))?.quantity || quantity });
      warehouse.push({ productId, warehouseStock: product?.warehouseStock || 0 });
    }
      return { repStock, warehouse };
    });
    afterCommit.push(() => pushHooks.sendPush([repId], { title: "Stock issued", body: "Your stock allocation has been updated", data: { type: "STOCK_ISSUED", repId } }));
    await Promise.allSettled(afterCommit.map((fn) => fn()));
    res.json(envelope(result));
  } catch (error) {
    const result = mapError(error);
    res.status(result.status).json(result.body);
  }
});

apiRouter.post("/api/v1/stock/return", auth, requireRole("admin"), async (req, res) => {
  const { repId, note } = req.body;
  const items = Array.isArray(req.body.items)
    ? req.body.items
    : req.body.productId
      ? [{ productId: req.body.productId, quantity: req.body.quantity }]
      : [];
  if (!items.length) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Items are required" } });
  try {
    const returned = await runTx(async (session) => {
    const merged = new Map<string, number>();
    for (const item of items) {
      const quantity = item.quantity ?? item.qty;
      if (!Number.isInteger(quantity) || quantity < 1) throw Object.assign(new Error("Quantity must be positive"), { code: "VALIDATION_ERROR", status: 400 });
      merged.set(item.productId, (merged.get(item.productId) || 0) + quantity);
    }
    for (const [productId, quantity] of merged) {
      const repStock = await RepStock.findOne({ repId, productId }).session(session);
      if (!repStock || repStock.quantity < quantity) throw Object.assign(new Error("Insufficient rep stock"), { code: "INSUFFICIENT_REP_STOCK", status: 422 });
      await RepStock.updateOne({ repId, productId }, { $inc: { quantity: -quantity } }, { session });
      await Product.updateOne({ _id: productId }, { $inc: { warehouseStock: quantity } }, { session });
      await StockMovement.create([{ type: "RETURN_TO_WAREHOUSE", productId, repId, quantity, performedBy: req.auth!.id, note }], { session });
    }
      const stockRows = await Promise.all(
        [...merged.keys()].map(async (productId) => {
          const repStock = await RepStock.findOne({ repId, productId }).session(session);
          const product = await Product.findById(productId).session(session);
          return {
            repStock: { productId, quantity: repStock?.quantity || 0 },
            warehouse: { productId, warehouseStock: product?.warehouseStock || 0 },
          };
        }),
      );
      return {
        repStock: stockRows.map((row) => row.repStock),
        warehouse: stockRows.map((row) => row.warehouse),
      };
    });
    res.json(envelope(returned));
  } catch (error) {
    const result = mapError(error);
    res.status(result.status).json(result.body);
  }
});

apiRouter.get("/api/v1/stock/movements", auth, requireRole("admin"), async (req, res) => {
  const query: any = {};
  if (req.query.repId) query.repId = req.query.repId;
  if (req.query.productId) query.productId = req.query.productId;
  if (req.query.type) query.type = req.query.type;
  if (req.query.from || req.query.to) {
    query.createdAt = {};
    if (req.query.from) query.createdAt.$gte = new Date(String(req.query.from));
    if (req.query.to) query.createdAt.$lte = new Date(String(req.query.to));
  }
  const total = await StockMovement.countDocuments(query);
  const meta = paginate(req.query.page, req.query.limit, total);
  const [items] = await Promise.all([
    StockMovement.find(query).populate("productId", "name").populate("repId", "name repCode").populate("performedBy", "name").sort({ createdAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean(),
  ]);
  res.json({ success: true, data: toApiObject(items as any), meta, error: null });
});

apiRouter.get("/api/v1/stock/me", auth, requireRole("rep"), async (req, res) => {
  const stock = await RepStock.find({ repId: req.auth!.id }).populate("productId", "name unitPrice imageUrl lowStockThreshold").lean();
  const items = stock.map((row: any) => ({
    productId: row.productId?._id,
    name: row.productId?.name,
    imageUrl: row.productId?.imageUrl,
    unitPrice: row.productId?.unitPrice,
    quantity: row.quantity,
    isLow: row.quantity <= (row.productId?.lowStockThreshold || 10),
  }));
  res.json(envelope({ repId: req.auth!.id, totalUnits: items.reduce((sum, row) => sum + row.quantity, 0), items }));
});

apiRouter.get("/api/v1/stock/reps/:repId", auth, requireRole("admin"), async (req, res) => {
  const stock = await RepStock.find({ repId: req.params.repId }).populate("productId", "name unitPrice lowStockThreshold imageUrl").lean();
  const items = stock.map((row: any) => ({
    productId: row.productId?._id,
    name: row.productId?.name,
    imageUrl: row.productId?.imageUrl,
    unitPrice: row.productId?.unitPrice,
    quantity: row.quantity,
    isLow: row.quantity <= (row.productId?.lowStockThreshold || 10),
  }));
  res.json(envelope({ repId: req.params.repId, totalUnits: items.reduce((sum, row) => sum + row.quantity, 0), items }));
});

apiRouter.post("/api/v1/customers", auth, requireRole("rep"), validateBody(customerSchema), async (req, res) => {
  if (req.body.clientId) {
    const existing = await Customer.findOne({ clientId: req.body.clientId, repId: req.auth!.id });
    if (existing) return res.set("Idempotent-Replayed", "true").json(envelope(existing));
  }
  const phone = normalizePhone(req.body.phone);
  const duplicate = await Customer.findOne({ repId: req.auth!.id, phone });
  if (duplicate) return res.status(409).json({ success: false, error: { code: "CUSTOMER_PHONE_EXISTS", message: "Customer phone already exists", details: [{ existingCustomerId: duplicate._id }] } });
  try {
    const customer = await Customer.create({ ...req.body, phone, repId: req.auth!.id });
    res.status(201).json(envelope(customer));
  } catch (error: any) {
    if (error?.code === 11000) {
      if (req.body.clientId) {
        const replay = await Customer.findOne({ repId: req.auth!.id, clientId: req.body.clientId });
        if (replay) return res.set("Idempotent-Replayed", "true").json(envelope(replay));
      }
      return res.status(409).json({ success: false, error: { code: "CUSTOMER_PHONE_EXISTS", message: "Customer phone already exists" } });
    }
    throw error;
  }
});

apiRouter.get("/api/v1/customers", auth, async (req, res) => {
  const query: any = req.auth!.role === "admin" ? {} : { repId: req.auth!.id };
  if (typeof req.query.q === "string") query.name = { $regex: req.query.q, $options: "i" } as any;
  if (req.query.repId && req.auth!.role === "admin") query.repId = req.query.repId;
  const meta = paginate(req.query.page, req.query.limit, await Customer.countDocuments(query));
  const customers = await Customer.find(query).sort(req.query.sort === "spent" ? { totalSpent: -1 } : req.query.sort === "recent" ? { lastOrderAt: -1 } : { name: 1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  res.json({ success: true, data: toApiObject(customers as any), meta, error: null });
});

apiRouter.get("/api/v1/customers/:id", auth, async (req, res) => {
  const query: any = { _id: req.params.id };
  if (req.auth!.role === "rep") query.repId = req.auth!.id;
  const customer = await Customer.findOne(query).lean();
  if (!customer) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Customer not found" } });
  const orders = await Order.find({ customerId: customer._id }).sort({ placedAt: -1 }).limit(10).lean();
  res.json(envelope({
    customer,
    recentOrders: orders.map((order: any) => ({
      id: order._id,
      orderNo: order.orderNo,
      receiptNo: order.receiptNo,
      status: order.status,
      total: order.total,
      itemCount: order.items?.length || 0,
      placedAt: order.placedAt,
    })),
  }));
});

apiRouter.patch("/api/v1/customers/:id", auth, requireRole("rep"), async (req, res) => {
  const customer = await Customer.findOneAndUpdate({ _id: req.params.id, repId: req.auth!.id }, req.body, { new: true, runValidators: true });
  if (!customer) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Customer not found" } });
  res.json(envelope(customer));
});

apiRouter.post("/api/v1/orders", auth, requireRole("rep"), validateBody(createOrderSchema), async (req, res) => {
  const existing = await Order.findOne({ clientId: req.body.clientId });
  if (existing) return res.set("Idempotent-Replayed", "true").json(envelope(existing));
  const placedAt = req.body.placedAt ? new Date(req.body.placedAt) : new Date();
  const now = Date.now();
  if (placedAt.getTime() > now || now - placedAt.getTime() > 7 * 24 * 60 * 60 * 1000) {
    return res.status(422).json({ success: false, error: { code: "VALIDATION_ERROR", message: "placedAt must be within the last 7 days and not in the future" } });
  }
  try {
    const afterCommit: Array<() => Promise<void>> = [];
    const order = await runTx(async (session) => {
    afterCommit.length = 0;
    const repId = req.auth!.id;
    const customer = await Customer.findOne({ _id: req.body.customerId, repId }).session(session);
    if (!customer) throw new ApiError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
    const merged = new Map<string, number>();
    for (const line of req.body.items) {
      merged.set(line.productId, (merged.get(line.productId) || 0) + line.quantity);
    }
    const items: any[] = [];
    const short: any[] = [];
    for (const [productId, quantity] of merged) {
      const stock = await RepStock.findOne({ repId, productId }).session(session);
      const available = stock?.quantity || 0;
      if (available < quantity) short.push({ productId, requested: quantity, available });
    }
    if (short.length) throw new ApiError(422, "INSUFFICIENT_STOCK", "Insufficient stock", short);
    for (const [productId, quantity] of merged) {
      const stock = await RepStock.updateOne({ repId, productId, quantity: { $gte: quantity } }, { $inc: { quantity: -quantity } }, { session });
      if (stock.modifiedCount !== 1) throw new ApiError(422, "INSUFFICIENT_STOCK", "Insufficient stock");
      const product = await Product.findById(productId).session(session);
      if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");
      if (!product.isActive) throw new ApiError(422, "PRODUCT_INACTIVE", "Product is inactive");
      items.push({ productId: product._id, name: product.name, unitPrice: product.unitPrice, qty: quantity, lineTotal: product.unitPrice * quantity });
    }
    const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
    const rep = await User.findById(repId).session(session);
    const lagosDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(placedAt).replace(/-/g, "").slice(-6);
    let receiptNo: string;
    if (req.body.paperReceiptNo) {
      const paperNo = Number(req.body.paperReceiptNo);
      if (!Number.isInteger(paperNo)) throw new ApiError(422, "INVALID_RECEIPT_NUMBER", "Invalid receipt number");
      const book = await ReceiptBook.findOneAndUpdate(
        { repId, prefix: "", status: "ACTIVE", startNo: { $lte: paperNo }, endNo: { $gte: paperNo }, nextNo: { $lte: paperNo } },
        { $set: { nextNo: paperNo + 1 } },
        { new: true, session },
      );
      if (!book) throw new ApiError(422, "NO_ACTIVE_RECEIPT_BOOK", "No active receipt book contains this number");
      if (await Order.findOne({ receiptNo: req.body.paperReceiptNo }).session(session)) throw new ApiError(422, "INVALID_RECEIPT_NUMBER", "Invalid receipt number");
      const remaining = Math.max(0, book.endNo - (paperNo + 1) + 1);
      if (remaining === 0) await ReceiptBook.updateOne({ _id: book._id }, { $set: { status: "FULL" } }, { session });
      if (remaining === 10) {
        afterCommit.push(async () => {
          const repAndAdmins = [repId, ...(await User.find({ role: "admin", isActive: true }).distinct("_id"))];
          await pushHooks.sendPush(repAndAdmins.map((id) => String(id)), { type: "RECEIPT_BOOK_LOW", title: "Receipt book low", body: "Only 10 receipt numbers remain", data: { type: "RECEIPT_BOOK_LOW", repId: String(repId), receiptBookId: book._id.toString() } });
        });
      }
      receiptNo = req.body.paperReceiptNo;
    } else {
      const receiptSequence = await getNextCounter(`receipt:${rep?.repCode}:${lagosDate}`, session);
      receiptNo = `RB-${rep?.repCode}-${lagosDate}-${String(receiptSequence).padStart(4, "0")}`;
    }
    const orderSequence = await getNextCounter(`order:${rep?.repCode}:${lagosDate}`, session);
    const orderNo = `ORD-${rep?.repCode}-${lagosDate}-${String(orderSequence).padStart(4, "0")}`;
    const lagosHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", hourCycle: "h23" }).format(placedAt));
    const order = await Order.create([{ orderNo, receiptNo, clientId: req.body.clientId, repId, customerId: customer._id, items, total, paymentMethod: req.body.paymentMethod, note: req.body.note, placedAt, placedHourLagos: lagosHour }], { session });
    await StockMovement.insertMany(items.map((item) => ({ type: "SALE", productId: item.productId, repId, quantity: item.qty, orderId: order[0]._id, performedBy: repId })), { session });
    await Customer.updateOne({ _id: customer._id }, { $inc: { orderCount: 1, totalSpent: total }, lastOrderAt: placedAt }, { session });
      return order[0];
    });
    for (const item of order.items) {
      const repStock = await RepStock.findOne({ repId: order.repId, productId: item.productId }).lean();
      const product = await Product.findById(item.productId).lean();
      const beforeQuantity = repStock ? repStock.quantity + item.qty : item.qty;
      if (repStock && product && beforeQuantity >= product.lowStockThreshold && repStock.quantity < product.lowStockThreshold) {
        afterCommit.push(() => pushHooks.sendPush([order.repId], { title: "Low stock", body: `${product.name} is low in stock`, data: { type: "LOW_STOCK", productId: product._id.toString(), repId: order.repId.toString() } }));
      }
    }
    await Promise.allSettled(afterCommit.map((fn) => fn()));
    res.status(201).json(envelope(order));
  } catch (error: any) {
    if (error?.code === 11000) {
      const replay = await Order.findOne({ clientId: req.body.clientId });
      if (replay) return res.set("Idempotent-Replayed", "true").json(envelope(replay));
    }
    const result = mapError(error);
    res.status(result.status).json(result.body);
  }
});

apiRouter.get("/api/v1/orders", auth, async (req, res) => {
  const query: any = req.auth!.role === "admin" ? {} : { repId: req.auth!.id };
  if (req.query.repId && req.auth!.role === "admin") query.repId = req.query.repId;
  if (req.query.customerId) query.customerId = req.query.customerId;
  if (req.query.status) query.status = req.query.status;
  if (req.query.from || req.query.to) {
    query.placedAt = {};
    if (req.query.from) query.placedAt.$gte = new Date(String(req.query.from));
    if (req.query.to) query.placedAt.$lte = new Date(String(req.query.to));
  }
  if (typeof req.query.q === "string") {
    const customerIds = await Customer.find({ name: { $regex: req.query.q, $options: "i" } }).distinct("_id");
    query.$or = [{ orderNo: { $regex: req.query.q, $options: "i" } }, { receiptNo: { $regex: req.query.q, $options: "i" } }, { customerId: { $in: customerIds } }];
  }
  const meta = paginate(req.query.page, req.query.limit, await Order.countDocuments(query));
  const items = await Order.find(query).populate("customerId", "name phone").populate("repId", "name repCode").sort({ placedAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  res.json({ success: true, data: toApiObject(items as any), meta, error: null });
});

apiRouter.get("/api/v1/orders/cancelled", auth, requireRole("admin"), async (req, res) => {
  const query: any = { status: "CANCELLED" };
  if (req.query.repId) query.repId = req.query.repId;
  if (req.query.from || req.query.to) {
    query.cancelledAt = {};
    if (req.query.from) query.cancelledAt.$gte = new Date(String(req.query.from));
    if (req.query.to) query.cancelledAt.$lte = new Date(String(req.query.to));
  }
  const meta = paginate(req.query.page, req.query.limit, await Order.countDocuments(query));
  const items = await Order.find(query).populate("repId", "name repCode").populate("customerId", "name phone").sort({ cancelledAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  res.json({ success: true, data: toApiObject(items as any), meta, error: null });
});

apiRouter.get("/api/v1/orders/:id", auth, async (req, res) => {
  const query: any = { _id: req.params.id };
  if (req.auth!.role === "rep") query.repId = req.auth!.id;
  const order = await Order.findOne(query).populate("repId", "name repCode vehicleReg").populate("customerId", "name phone address").lean();
  if (!order) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Order not found" } });
  res.json(envelope(order));
});

apiRouter.get("/api/v1/orders/:id/receipt", auth, async (req, res) => {
  const query: any = { _id: req.params.id };
  if (req.auth!.role === "rep") query.repId = req.auth!.id;
  const order = await Order.findOne(query).populate("repId", "name repCode").populate("customerId", "name phone address").lean();
  if (!order) return res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Order not found" } });
  res.json(envelope({
    receiptNo: order.receiptNo,
    status: order.status,
    business: {
      name: process.env.BUSINESS_NAME || "RichBake",
      phone: process.env.BUSINESS_PHONE || "",
      address: process.env.BUSINESS_ADDRESS || "",
    },
    rep: {
      name: (order.repId as any)?.name,
      repCode: (order.repId as any)?.repCode,
      vehicleReg: (order.repId as any)?.vehicleReg,
    },
    customer: {
      name: (order.customerId as any)?.name,
      phone: (order.customerId as any)?.phone,
      address: (order.customerId as any)?.address,
    },
    items: order.items,
    total: order.total,
    placedAt: order.placedAt,
    cancelledAt: order.cancelledAt,
  }));
});

apiRouter.post("/api/v1/orders/:id/cancel", auth, async (req, res) => {
  if (typeof req.body.reason !== "string" || req.body.reason.trim().length < 3 || req.body.reason.trim().length > 200) return res.status(400).json({ success: false, data: null, error: { code: "VALIDATION_ERROR", message: "Cancellation reason must be 3 to 200 characters" } });
  try {
    const afterCommit: Array<() => Promise<void>> = [];
    const order = await runTx(async (session) => {
    afterCommit.length = 0;
    const claimed = await Order.findOneAndUpdate(
      { _id: req.params.id, status: "COMPLETED" },
      { $set: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: req.body.reason.trim(), cancelledBy: new mongoose.Types.ObjectId(req.auth!.id) } },
      { new: true, session },
    );
    if (!claimed) {
      const existing = await Order.findById(req.params.id).session(session);
      if (!existing) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
      throw new ApiError(409, "ORDER_ALREADY_CANCELLED", "Order is already cancelled");
    }
    if (req.auth!.role !== "admin" && claimed.repId.toString() !== req.auth!.id) throw new ApiError(403, "FORBIDDEN", "Not your order");
    if (req.auth!.role !== "admin" && Date.now() - claimed.placedAt.getTime() > 24 * 60 * 60 * 1000) throw new ApiError(422, "CANCEL_WINDOW_EXPIRED", "24-hour cancellation window has expired");
    const order = claimed;
    for (const item of order.items) await RepStock.updateOne({ repId: order.repId, productId: item.productId }, { $inc: { quantity: item.qty } }, { upsert: true, session });
    await StockMovement.insertMany(order.items.map((item) => ({ type: "CANCEL_RETURN", productId: item.productId, repId: order.repId, quantity: item.qty, orderId: order._id, performedBy: req.auth!.id, note: req.body.reason })), { session });
    order.status = "CANCELLED"; order.cancelledAt = new Date(); order.cancelReason = req.body.reason; order.cancelledBy = new mongoose.Types.ObjectId(req.auth!.id);
    await order.save({ session });
    await Customer.updateOne({ _id: order.customerId }, { $inc: { orderCount: -1, totalSpent: -order.total } }, { session });
      return order;
    });
    await Notification.create({ userId: order.repId, type: "ORDER_CANCELLED", title: "Order cancelled", body: `Order ${order.orderNo} was cancelled`, data: { type: "ORDER_CANCELLED", orderId: order._id } });
    const admins = await User.find({ role: "admin", isActive: true }).distinct("_id");
    afterCommit.push(() => pushHooks.sendPush(admins, { title: "Order cancelled", body: `Order ${order.orderNo} was cancelled`, data: { type: "ORDER_CANCELLED", orderId: order._id.toString() } }));
    await Promise.allSettled(afterCommit.map((fn) => fn()));
    res.json(envelope(order));
  } catch (error) {
    const result = mapError(error);
    res.status(result.status).json(result.body);
  }
});

apiRouter.post("/api/v1/receipt-books", auth, requireRole("admin"), async (req, res) => {
  const { repId, startNo, endNo, prefix = "" } = req.body;
  if (!Number.isInteger(startNo) || !Number.isInteger(endNo) || endNo < startNo) {
    return res.status(400).json({ success: false, data: null, error: { code: "VALIDATION_ERROR", message: "Enter a valid receipt number range" } });
  }
  if (endNo - startNo + 1 > 1000) return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "A receipt book cannot exceed 1000 numbers" } });
  if (!await User.exists({ _id: repId, role: "rep" })) return res.status(404).json({ success: false, error: { code: "USER_NOT_FOUND", message: "Rep not found" } });
  const overlap = await ReceiptBook.findOne({ prefix, status: "ACTIVE", startNo: { $lte: endNo }, endNo: { $gte: startNo } });
  if (overlap) return res.status(409).json({ success: false, data: null, error: { code: "RANGE_OVERLAP", message: "Receipt block overlaps another active block" } });
  const book = await ReceiptBook.create({ repId, prefix, startNo, endNo, nextNo: startNo, assignedBy: req.auth!.id });
  res.status(201).json(envelope({ id: book._id, repId: book.repId, prefix: book.prefix, startNo, endNo, usedCount: 0, remaining: endNo - startNo + 1, status: book.status }));
});

apiRouter.get("/api/v1/receipt-books", auth, requireRole("admin"), async (req, res) => {
  const query: any = {};
  if (req.query.repId) query.repId = req.query.repId;
  if (req.query.status) query.status = req.query.status;
  const meta = paginate(req.query.page, req.query.limit, await ReceiptBook.countDocuments(query));
  const items = await ReceiptBook.find(query).populate("repId", "name repCode").sort({ assignedAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  res.json({ success: true, data: toApiObject(items as any), meta, error: null });
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


async function buildSalesReport(match: Record<string, unknown>, reqQuery: any) {
  const range = lagosRange(reqQuery.period, reqQuery.from, reqQuery.to);
  const groupBy = String(reqQuery.groupBy || (range.period === "today" ? "hour" : range.period === "year" ? "month" : "day"));
  const units: Record<string, string> = { hour: "hour", day: "day", week: "week", month: "month" };
  const unit = units[groupBy] || "day";
  const query = {
    ...match,
    status: "COMPLETED",
    placedAt: { $gte: range.from, $lt: range.to },
  };
  const totalsRows = await Order.aggregate([
    { $match: query },
    { $group: {
      _id: null,
      revenue: { $sum: "$total" },
      orders: { $sum: 1 },
      units: { $sum: { $sum: "$items.qty" } },
      cancelledOrders: { $sum: 0 },
    } },
  ]);
  const seriesRows = await Order.aggregate([
    { $match: query },
    { $group: {
      _id: { $dateTrunc: { date: "$placedAt", unit, timezone: "Africa/Lagos" } },
      revenue: { $sum: "$total" },
      orders: { $sum: 1 },
    } },
    { $sort: { _id: 1 } },
  ]);
  const productRows = await Order.aggregate([
    { $match: query },
    { $unwind: "$items" },
    { $group: {
      _id: "$items.productId",
      name: { $first: "$items.name" },
      units: { $sum: "$items.qty" },
      revenue: { $sum: "$items.lineTotal" },
    } },
  ]);
  const totals = totalsRows[0] || { revenue: 0, orders: 0, units: 0 };
  const averageOrderValue = totals.orders ? Math.round(totals.revenue / totals.orders) : 0;
  return {
    period: {
      from: range.from.toISOString().slice(0, 10),
      to: new Date(range.to.getTime() - 1).toISOString().slice(0, 10),
      label: range.period,
    },
    totals: {
      revenue: totals.revenue,
      orders: totals.orders,
      units: totals.units,
      cancelledOrders: totals.cancelledOrders,
      averageOrderValue,
    },
    series: seriesRows.map((row) => ({
      key: unit === "hour"
        ? row._id.toISOString()
        : row._id.toISOString().slice(0, unit === "month" ? 7 : 10),
      revenue: row.revenue,
      orders: row.orders,
    })),
    byProduct: productRows.map((row) => ({
      productId: row._id,
      name: row.name,
      units: row.units,
      revenue: row.revenue,
    })),
  };
}

apiRouter.get("/api/v1/reports/sales/me", auth, requireRole("rep"), async (req, res) => {
  res.json(envelope(await buildSalesReport({ repId: new mongoose.Types.ObjectId(req.auth!.id) }, req.query)));
});

apiRouter.get("/api/v1/reports/sales/reps/:repId", auth, requireRole("admin"), async (req, res) => {
  const repId = String(req.params.repId);
  res.json(envelope(await buildSalesReport({ repId: new mongoose.Types.ObjectId(repId) }, req.query)));
});

apiRouter.get("/api/v1/reports/sales/overview", auth, requireRole("admin"), async (req, res) => {
  const match: Record<string, unknown> = {};
  if (typeof req.query.area === "string") match.area = req.query.area;
  res.json(envelope(await buildSalesReport(match, req.query)));
});

apiRouter.get("/api/v1/reports/leaderboard/reps", auth, requireRole("admin"), async (req, res) => {
  const range = lagosRange(req.query.period, req.query.from, req.query.to);
  const metric = String(req.query.metric || "revenue");
  const query: any = { status: "COMPLETED", placedAt: { $gte: range.from, $lt: range.to } };
  if (typeof req.query.area === "string") query.area = req.query.area;
  const data = await Order.aggregate([
    { $match: query },
    { $group: { _id: "$repId", revenue: { $sum: "$total" }, orders: { $sum: 1 }, units: { $sum: { $sum: "$items.qty" } } } },
    { $sort: metric === "orders" ? { orders: -1, revenue: -1 } : metric === "units" ? { units: -1, orders: -1 } : { revenue: -1, orders: -1 } },
    { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "rep" } },
    { $unwind: "$rep" },
    { $project: { repId: "$_id", name: "$rep.name", repCode: "$rep.repCode", revenue: 1, orders: 1, units: 1, _id: 0 } },
  ]);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
  const items = data.slice(0, limit).map((row: any, index: number) => ({
    rank: index + 1,
    rep: { id: row.repId, name: row.name, repCode: row.repCode },
    revenue: row.revenue,
    orders: row.orders,
    units: row.units,
  }));
  res.json(envelope({ period: range.period, metric, items }));
});

apiRouter.get("/api/v1/reports/customers/top", auth, async (req, res) => {
  if (req.auth!.role === "rep" && typeof req.query.repId === "string") {
    return res.status(403).json({ success: false, data: null, error: { code: "FORBIDDEN", message: "A rep cannot query another rep" } });
  }
  const repId = req.auth!.role === "admin" && typeof req.query.repId === "string" ? req.query.repId : req.auth!.id;
  const customers = await Customer.find({ repId }).sort({ totalSpent: -1 }).limit(Number(req.query.limit) || 10).lean();
  const items = customers.map((customer: any, index: number) => ({
    rank: index + 1,
    customer: { id: customer._id, name: customer.name, phone: customer.phone },
    orders: customer.orderCount,
    totalSpent: customer.totalSpent,
    lastOrderAt: customer.lastOrderAt,
  }));
  res.json(envelope({ items }));
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
  res.json(envelope({
    items: data.map((row) => ({
      productId: row._id,
      name: row.name,
      units: row.quantity,
      revenue: row.revenue,
    })),
  }));
});

apiRouter.get("/api/v1/auth/me", auth, async (req, res) => {
  const user = await User.findById(req.auth!.id).select("-passwordHash -refreshTokenHash").lean();
  if (!user) return res.status(404).json({ success: false, error: { code: "USER_NOT_FOUND", message: "User not found" } });
  res.json(envelope({ ...user, id: user._id }));
});

apiRouter.delete("/api/v1/auth/push-token", auth, async (req, res) => {
  if (typeof req.body.token !== "string") {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "Push token is required" } });
  }
  await User.updateOne({ _id: req.auth!.id }, { $pull: { pushTokens: req.body.token } });
  res.json(envelope({ removed: true }));
});

apiRouter.get("/api/v1/notifications/unread-count", auth, async (req, res) => {
  const count = await Notification.countDocuments({ userId: req.auth!.id, readAt: { $exists: false } });
  res.json(envelope({ count }));
});

apiRouter.post("/api/v1/notifications/read-all", auth, async (req, res) => {
  const result = await Notification.updateMany({ userId: req.auth!.id, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  res.json(envelope({ updated: result.modifiedCount }));
});

apiRouter.get("/api/v1/notifications/preferences", auth, async (req, res) => {
  const user = await User.findById(req.auth!.id).select("notificationPrefs").lean();
  res.json(envelope({
    orderCancelled: true,
    stockIssued: true,
    lowStock: true,
    receiptBookLow: true,
    dailySummary: true,
    newOrder: false,
    accountAlerts: true,
    ...(user?.notificationPrefs ? Object.fromEntries(user.notificationPrefs instanceof Map ? user.notificationPrefs : Object.entries(user.notificationPrefs)) : {}),
  }));
});

apiRouter.patch("/api/v1/notifications/preferences", auth, async (req, res) => {
  const allowed = ["orderCancelled", "stockIssued", "lowStock", "receiptBookLow", "dailySummary", "newOrder", "accountAlerts"];
  const updates: Record<string, boolean> = {};
  for (const key of allowed) if (typeof req.body[key] === "boolean") updates[key] = req.body[key];
  await User.updateOne({ _id: req.auth!.id }, { $set: Object.fromEntries(Object.entries(updates).map(([key, value]) => [`notificationPrefs.${key}`, value])) });
  const user = await User.findById(req.auth!.id).select("notificationPrefs").lean();
  res.json(envelope(user?.notificationPrefs || {}));
});

apiRouter.post("/api/v1/stock/adjust", auth, requireRole("admin"), async (req, res) => {
  const items = Array.isArray(req.body.items)
    ? req.body.items
    : req.body.productId
      ? [{ productId: req.body.productId, quantity: req.body.quantity, repId: req.body.repId }]
      : [];
  if (!items.length || typeof req.body.reason !== "string" || !req.body.reason.trim()) {
    return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "items and reason are required" } });
  }
  try {
    await runTx(async (session) => {
    for (const item of items) {
      const quantity = item.quantity;
      const repId = item.repId || req.body.repId;
      if (!Number.isInteger(quantity) || quantity === 0) throw Object.assign(new Error("Quantity must be a non-zero integer"), { code: "VALIDATION_ERROR", status: 400 });
      let current: number;
      if (repId) {
        const row = await RepStock.findOne({ repId, productId: item.productId }).session(session);
        current = (row?.quantity || 0) + quantity;
        if (current < 0) throw Object.assign(new Error("Insufficient stock"), { code: "INSUFFICIENT_STOCK", status: 422 });
        await RepStock.updateOne({ repId, productId: item.productId }, { $set: { quantity: current } }, { upsert: true, session });
      } else {
        const product = await Product.findById(item.productId).session(session);
        if (!product) throw Object.assign(new Error("Product not found"), { code: "PRODUCT_NOT_FOUND", status: 404 });
        current = product.warehouseStock + quantity;
        if (current < 0) throw Object.assign(new Error("Insufficient stock"), { code: "INSUFFICIENT_STOCK", status: 422 });
        await Product.updateOne({ _id: item.productId }, { $set: { warehouseStock: current } }, { session });
      }
      await StockMovement.create([{ type: "ADJUSTMENT", productId: item.productId, repId, quantity, performedBy: req.auth!.id, note: req.body.reason }], { session });
    }
    });
    res.json(envelope({ adjusted: items.length }));
  } catch (error) {
    const result = mapError(error);
    res.status(result.status).json(result.body);
  }
});

apiRouter.get("/api/v1/stock/warehouse", auth, requireRole("admin"), async (_req, res) => {
  const products = await Product.find().sort({ name: 1 }).lean();
  res.json(envelope(products.map((product) => ({
    productId: product._id,
    name: product.name,
    imageUrl: product.imageUrl,
    warehouseStock: product.warehouseStock,
    lowStockThreshold: product.lowStockThreshold,
    isLow: product.warehouseStock <= product.lowStockThreshold,
  }))));
});

apiRouter.get("/api/v1/stock/low", auth, requireRole("admin"), async (_req, res) => {
  const products = await Product.find().lean();
  const warehouse = products.filter((product) => product.warehouseStock <= product.lowStockThreshold).map((product) => ({
    productId: product._id, name: product.name, warehouseStock: product.warehouseStock, threshold: product.lowStockThreshold,
  }));
  const repRows = await RepStock.find().populate("repId", "name repCode").populate("productId", "name lowStockThreshold").lean();
  const reps = repRows.filter((row: any) => row.quantity <= (row.productId?.lowStockThreshold || 10)).map((row: any) => ({
    rep: { id: row.repId?._id, name: row.repId?.name, repCode: row.repId?.repCode },
    product: { id: row.productId?._id, name: row.productId?.name },
    quantity: row.quantity,
    threshold: row.productId?.lowStockThreshold || 10,
  }));
  res.json(envelope({ warehouse, reps }));
});

apiRouter.get("/api/v1/reports/dashboard", auth, requireRole("admin"), async (_req, res) => {
  const todayStart = lagosMidnightUtc();
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const today = await Order.aggregate([
    { $match: { status: "COMPLETED", placedAt: { $gte: todayStart, $lt: todayEnd } } },
    { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 }, units: { $sum: { $sum: "$items.qty" } } } },
  ]);
  const cancelled = await Order.countDocuments({ status: "CANCELLED", cancelledAt: { $gte: todayStart, $lt: todayEnd } });
  const trend = await Order.aggregate([
    { $match: { status: "COMPLETED", placedAt: { $gte: new Date(Date.now() - 7 * 86400000) } } },
    { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$placedAt", timezone: "Africa/Lagos" } }, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  const topRep = await Order.aggregate([
    { $match: { status: "COMPLETED", placedAt: { $gte: todayStart, $lt: todayEnd } } },
    { $group: { _id: "$repId", revenue: { $sum: "$total" } } },
    { $sort: { revenue: -1 } }, { $limit: 1 },
    { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "rep" } }, { $unwind: "$rep" },
  ]);
  const lowStockCount = await Product.countDocuments({ $expr: { $lte: ["$warehouseStock", "$lowStockThreshold"] } });
  const recentCancelled = await Order.find({ status: "CANCELLED" }).populate("repId", "name repCode").populate("customerId", "name").sort({ cancelledAt: -1 }).limit(3).lean();
  res.json(envelope({
    today: { revenue: today[0]?.revenue || 0, orders: today[0]?.orders || 0, units: today[0]?.units || 0, cancelledOrders: cancelled, activeReps: await User.countDocuments({ role: "rep", isActive: true }) },
    trend: trend.map((row) => ({ date: row._id, revenue: row.revenue, orders: row.orders })),
    topRepToday: topRep[0] ? { rep: { id: topRep[0]._id, name: topRep[0].rep.name, repCode: topRep[0].rep.repCode }, revenue: topRep[0].revenue } : null,
    lowStockCount,
    recentCancelled,
  }));
});

apiRouter.get("/api/v1/reports/home/me", auth, requireRole("rep"), async (req, res) => {
  const todayStart = lagosMidnightUtc();
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  const today = await Order.aggregate([
    { $match: { repId: new mongoose.Types.ObjectId(req.auth!.id), status: "COMPLETED", placedAt: { $gte: todayStart, $lt: todayEnd } } },
    { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 }, units: { $sum: { $sum: "$items.qty" } } } },
  ]);
  const stock = await RepStock.find({ repId: req.auth!.id }).populate("productId", "name lowStockThreshold").lean();
  const lowStockItems = stock.filter((row: any) => row.quantity <= (row.productId?.lowStockThreshold || 10)).map((row: any) => ({ productId: row.productId._id, name: row.productId.name, quantity: row.quantity }));
  const lastOrders = await Order.find({ repId: req.auth!.id }).populate("customerId", "name").sort({ placedAt: -1 }).limit(3).lean();
  res.json(envelope({
    today: { revenue: today[0]?.revenue || 0, orders: today[0]?.orders || 0, units: today[0]?.units || 0 },
    stockUnits: stock.reduce((sum: number, row: any) => sum + row.quantity, 0),
    lowStockItems,
    lastOrders,
  }));
});

apiRouter.get("/api/v1/reports/customers/preferred-time", auth, async (req, res) => {
  const repId = req.auth!.role === "admin" && req.query.repId ? String(req.query.repId) : req.auth!.id;
  const match: any = { repId: new mongoose.Types.ObjectId(repId), status: "COMPLETED" };
  if (typeof req.query.customerId === "string") match.customerId = new mongoose.Types.ObjectId(req.query.customerId);
  if (req.query.from || req.query.to) match.placedAt = {};
  if (req.query.from) match.placedAt.$gte = new Date(`${req.query.from}T00:00:00.000Z`);
  if (req.query.to) match.placedAt.$lte = new Date(`${req.query.to}T23:59:59.999Z`);
  const rows = await Order.aggregate([
    { $match: match },
    { $group: { _id: "$placedHourLagos", orders: { $sum: 1 } } },
  ]);
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: rows.find((row) => row._id === hour)?.orders || 0 }));
  let bestStart = 0;
  let bestTotal = -1;
  for (let start = 0; start < 24; start++) {
    const total = hours[start].orders + hours[(start + 1) % 24].orders;
    if (total > bestTotal) { bestTotal = total; bestStart = start; }
  }
  const sampleSize = hours.reduce((sum, row) => sum + row.orders, 0);
  const buckets = {
    morning: hours.slice(6, 12).reduce((sum, row) => sum + row.orders, 0),
    afternoon: hours.slice(12, 17).reduce((sum, row) => sum + row.orders, 0),
    evening: hours.slice(17, 21).reduce((sum, row) => sum + row.orders, 0),
    night: hours.filter((row) => row.hour < 6 || row.hour >= 21).reduce((sum, row) => sum + row.orders, 0),
  };
  res.json(envelope({
    customerId: req.query.customerId ? String(req.query.customerId) : null,
    sampleSize,
    enoughData: sampleSize >= 3,
    hours,
    topWindow: { startHour: bestStart, endHour: (bestStart + 2) % 24, label: `${bestStart}:00-${(bestStart + 2) % 24}:00` },
    buckets,
  }));
});

apiRouter.post("/api/v1/internal/jobs/daily-summary", async (req, res) => {
  if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) return res.status(401).json({ success: false, error: { code: "INVALID_CRON_SECRET", message: "Invalid cron secret" } });
  const date = typeof req.body.date === "string" ? req.body.date : lagosDateParts(new Date()).year + "-" + String(lagosDateParts(new Date()).month + 1).padStart(2, "0") + "-" + String(lagosDateParts(new Date()).day).padStart(2, "0");
  const key = `daily-summary:${date}`;
  try {
    await JobRun.create({ key });
  } catch (error: any) {
    if (error?.code === 11000) return res.json(envelope({ date, sent: 0, alreadySent: true }));
    throw error;
  }
  const start = new Date(`${date}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const totals = await Order.aggregate([
    { $match: { placedAt: { $gte: start, $lt: end } } },
    { $group: { _id: null, revenue: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, "$total", 0] } }, orders: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } }, units: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, { $sum: "$items.qty" }, 0] } }, cancellations: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } } } },
  ]);
  const data = totals[0] || { revenue: 0, orders: 0, units: 0, cancellations: 0 };
  const admins = await User.find({ role: "admin", isActive: true }).distinct("_id");
  await pushHooks.sendPush(admins, { type: "DAILY_SUMMARY", title: "Daily summary", body: `${date}: ${data.orders} orders, ₦${data.revenue / 100}`, data: { type: "DAILY_SUMMARY", date } });
  res.json(envelope({ date, sent: 1, alreadySent: false, ...data }));
});

apiRouter.post("/api/v1/internal/jobs/low-stock-check", async (_req, res) => {
  if (_req.headers["x-cron-secret"] !== process.env.CRON_SECRET) return res.status(401).json({ success: false, error: { code: "INVALID_CRON_SECRET", message: "Invalid cron secret" } });
  const now = new Date();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  let sent = 0;
  const products = await Product.find().lean();
  for (const product of products) {
    if (product.warehouseStock <= product.lowStockThreshold) {
      const key = `warehouse:${product._id}`;
      const alert = await AlertState.findOne({ key }).lean();
      if (!alert || alert.lastSentAt < cutoff) {
        await AlertState.findOneAndUpdate({ key }, { $set: { lastSentAt: now } }, { upsert: true });
        const admins = await User.find({ role: "admin", isActive: true }).distinct("_id");
        await pushHooks.sendPush(admins, { type: "LOW_STOCK", title: "Low warehouse stock", body: `${product.name} is low`, data: { type: "LOW_STOCK", productId: product._id.toString() } });
        sent++;
      }
    }
  }
  const repStocks = await RepStock.find().populate("productId", "name lowStockThreshold").populate("repId", "name").lean();
  for (const row of repStocks as any[]) {
    const threshold = row.productId?.lowStockThreshold || 10;
    if (row.quantity <= threshold) {
      const key = `rep:${row.repId?._id}:${row.productId?._id}`;
      const alert = await AlertState.findOne({ key }).lean();
      if (!alert || alert.lastSentAt < cutoff) {
        await AlertState.findOneAndUpdate({ key }, { $set: { lastSentAt: now } }, { upsert: true });
        await pushHooks.sendPush([row.repId._id], { type: "LOW_STOCK", title: "Low stock", body: `${row.productId?.name || "Product"} is low`, data: { type: "LOW_STOCK", repId: row.repId._id.toString(), productId: row.productId?._id?.toString() } });
        sent++;
      }
    }
  }
  res.json(envelope({ checked: products.length + repStocks.length, sent }));
});
