import { Router } from "express";
import bcrypt from "bcryptjs";
import { createRepSchema, resetPasswordSchema, statusSchema, updateRepSchema } from "@richbake/shared";
import { Counter, Customer, Order, RepStock, User } from "../models";
import { auth, requireRole } from "../middleware/auth.middleware";
import { pushHooks } from "../services/push.service";
import { generateTemporaryPassword, revokeSession } from "../services/token.service";
import { DAY_MS, lagosMidnightUtc, startOfLagosMonth, startOfLagosWeek } from "../utils/dates";
import { envelope, listMeta, normalizePhone, queryString, searchPattern, sendError, sendList, validateBody } from "../utils/http";

export const usersRouter = Router();
usersRouter.use(auth, requireRole("admin"));

const PUBLIC_FIELDS = "-passwordHash -refreshTokenHash -refreshTokenSessionId -pushTokens";

async function nextRepCode() {
  const counter = await Counter.findOneAndUpdate({ key: "repCode" }, { $inc: { sequence: 1 } }, { new: true, upsert: true });
  return `R${String(counter.sequence).padStart(3, "0")}`;
}

usersRouter.post("/", validateBody(createRepSchema), async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (await User.exists({ phone })) return sendError(res, 409, "PHONE_EXISTS", "Phone already exists");
  const repCode = await nextRepCode();
  const temporaryPassword = req.body.temporaryPassword || generateTemporaryPassword();
  const { temporaryPassword: _omit, ...profile } = req.body;
  const user = await User.create({
    ...profile,
    phone,
    repCode,
    role: "rep",
    mustChangePassword: true,
    passwordHash: await bcrypt.hash(temporaryPassword, 12),
  });
  res.status(201).json(envelope({ user: { id: user._id, repCode, name: user.name, phone: user.phone, role: "rep", isActive: true, mustChangePassword: true }, temporaryPassword }));
});

usersRouter.get("/", async (req, res) => {
  const query: Record<string, unknown> = { role: "rep" };
  const status = queryString(req.query.status) ?? "active";
  if (status === "active") query.isActive = true;
  if (status === "inactive") query.isActive = false;
  const area = queryString(req.query.area);
  if (area) query.area = area;
  const q = queryString(req.query.q);
  if (q) query.$or = [{ name: searchPattern(q) }, { phone: searchPattern(q) }, { repCode: searchPattern(q) }];

  const meta = listMeta(req.query.page, req.query.limit, await User.countDocuments(query));
  let users: Record<string, unknown>[] = await User.find(query).select(PUBLIC_FIELDS).sort({ name: 1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  if (req.query.include === "summary" && users.length) {
    const repIds = users.map((user) => user._id);
    const todayStart = lagosMidnightUtc();
    const [sales, stock] = await Promise.all([
      Order.aggregate([
        { $match: { repId: { $in: repIds }, status: "COMPLETED", placedAt: { $gte: todayStart, $lt: new Date(todayStart.getTime() + DAY_MS) } } },
        { $group: { _id: "$repId", revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
      ]),
      RepStock.aggregate([
        { $match: { repId: { $in: repIds } } },
        { $group: { _id: "$repId", stockUnits: { $sum: "$quantity" } } },
      ]),
    ]);
    const salesByRep = new Map(sales.map((row) => [String(row._id), row]));
    const stockByRep = new Map(stock.map((row) => [String(row._id), row.stockUnits]));
    users = users.map((user) => {
      const id = String(user._id);
      return { ...user, todayRevenue: salesByRep.get(id)?.revenue ?? 0, todayOrders: salesByRep.get(id)?.orders ?? 0, stockUnits: stockByRep.get(id) ?? 0 };
    });
  }
  sendList(res, users, meta);
});

usersRouter.get("/:id", async (req, res) => {
  const user = await User.findOne({ _id: req.params.id, role: "rep" }).select(PUBLIC_FIELDS).lean();
  if (!user) return sendError(res, 404, "NOT_FOUND", "Rep not found");
  const completed = (from: Date) => ({ repId: user._id, status: "COMPLETED", placedAt: { $gte: from } });
  const revenue = (from: Date) => Order.aggregate([{ $match: completed(from) }, { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 } } }]);
  const [stock, today, week, month, lastOrder, customerCount] = await Promise.all([
    RepStock.find({ repId: user._id }).populate("productId", "name unitPrice").lean(),
    revenue(lagosMidnightUtc()),
    revenue(startOfLagosWeek()),
    revenue(startOfLagosMonth()),
    Order.findOne({ repId: user._id }).sort({ placedAt: -1 }).select("placedAt").lean(),
    Customer.countDocuments({ repId: user._id }),
  ]);
  res.json(envelope({
    ...user,
    stock,
    customerCount,
    summary: {
      todayRevenue: today[0]?.revenue ?? 0,
      todayOrders: today[0]?.orders ?? 0,
      weekRevenue: week[0]?.revenue ?? 0,
      monthRevenue: month[0]?.revenue ?? 0,
      stockUnits: stock.reduce((sum, row) => sum + row.quantity, 0),
      lastOrderAt: lastOrder?.placedAt ?? null,
    },
  }));
});

usersRouter.patch("/:id", validateBody(updateRepSchema), async (req, res) => {
  const update = { ...req.body, ...(req.body.phone ? { phone: normalizePhone(req.body.phone) } : {}) };
  if (update.phone && await User.exists({ phone: update.phone, _id: { $ne: req.params.id } })) {
    return sendError(res, 409, "PHONE_EXISTS", "Phone already exists");
  }
  const user = await User.findOneAndUpdate({ _id: req.params.id, role: "rep" }, { $set: update }, { new: true, runValidators: true }).select(PUBLIC_FIELDS);
  if (!user) return sendError(res, 404, "NOT_FOUND", "Rep not found");
  res.json(envelope(user));
});

usersRouter.patch("/:id/status", validateBody(statusSchema), async (req, res) => {
  if (req.params.id === req.auth!.id) return sendError(res, 422, "CANNOT_DEACTIVATE_SELF", "You cannot deactivate your own account");
  const user = await User.findOneAndUpdate({ _id: req.params.id, role: "rep" }, { isActive: req.body.isActive }, { new: true }).select(PUBLIC_FIELDS);
  if (!user) return sendError(res, 404, "USER_NOT_FOUND", "Rep not found");
  if (!req.body.isActive) {
    await revokeSession(user._id.toString());
    await Promise.allSettled([
      pushHooks.sendPush([user._id], { type: "ACCOUNT_ALERT", title: "Account deactivated", body: "Your account has been deactivated", data: { type: "ACCOUNT_ALERT", repId: user._id.toString() } }),
    ]);
  }
  res.json(envelope(user));
});

usersRouter.post("/:id/reset-password", validateBody(resetPasswordSchema), async (req, res) => {
  const user = await User.findOneAndUpdate(
    { _id: req.params.id, role: "rep" },
    { passwordHash: await bcrypt.hash(req.body.temporaryPassword, 12), mustChangePassword: true, $unset: { refreshTokenHash: 1, refreshTokenSessionId: 1 } },
  );
  if (!user) return sendError(res, 404, "USER_NOT_FOUND", "Rep not found");
  await Promise.allSettled([
    pushHooks.sendPush([user._id], { type: "ACCOUNT_ALERT", title: "Password reset", body: "An administrator reset your password", data: { type: "ACCOUNT_ALERT", repId: user._id.toString() } }),
  ]);
  res.json(envelope({ reset: true }));
});
