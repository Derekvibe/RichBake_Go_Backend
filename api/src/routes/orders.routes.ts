import { Router } from "express";
import mongoose, { type ClientSession } from "mongoose";
import { cancelOrderSchema, createOrderSchema } from "@richbake/shared";
import { Counter, Customer, Order, Product, ReceiptBook, RepStock, StockMovement, User } from "../models";
import { auth, requireRole } from "../middleware/auth.middleware";
import { env } from "../config/env";
import { activeAdminIds, pushHooks } from "../services/push.service";
import { DAY_MS, lagosDateCode, lagosHour } from "../utils/dates";
import { envelope, listMeta, queryDate, queryString, searchPattern, sendError, sendList, validateBody } from "../utils/http";
import { ApiError, runTx } from "../utils/transactions";

export const ordersRouter = Router();
ordersRouter.use(auth);

const BACKDATE_LIMIT_MS = 7 * DAY_MS;
const REP_CANCEL_WINDOW_MS = DAY_MS;
const RECEIPT_BOOK_LOW_AT = 10;

async function nextSequence(key: string, session: ClientSession) {
  const counter = await Counter.findOneAndUpdate({ key }, { $inc: { sequence: 1 } }, { new: true, upsert: true, session });
  return counter.sequence;
}

type AfterCommit = () => Promise<unknown>;

/** Claims a paper receipt number from the rep's active book; returns follow-up alerts to send after commit. */
async function claimPaperReceipt(repId: string, paperReceiptNo: string, session: ClientSession, afterCommit: AfterCommit[]) {
  const paperNo = Number(paperReceiptNo);
  if (await Order.exists({ receiptNo: paperReceiptNo }).session(session)) throw new ApiError(422, "INVALID_RECEIPT_NUMBER", "This receipt number has already been used");
  const book = await ReceiptBook.findOneAndUpdate(
    { repId, prefix: "", status: "ACTIVE", startNo: { $lte: paperNo }, endNo: { $gte: paperNo }, nextNo: { $lte: paperNo } },
    { $set: { nextNo: paperNo + 1 } },
    { new: false, session },
  );
  if (!book) throw new ApiError(422, "NO_ACTIVE_RECEIPT_BOOK", "No active receipt book contains this number");
  const remainingBefore = book.endNo - book.nextNo + 1;
  const remaining = book.endNo - paperNo;
  if (remaining === 0) await ReceiptBook.updateOne({ _id: book._id }, { $set: { status: "FULL" } }, { session });
  // Alert once, when the remaining count first drops to the threshold (numbers can be skipped).
  if (remainingBefore > RECEIPT_BOOK_LOW_AT && remaining <= RECEIPT_BOOK_LOW_AT) {
    afterCommit.push(async () => {
      const recipients = [repId, ...(await activeAdminIds()).map(String)];
      await pushHooks.sendPush(recipients, { type: "RECEIPT_BOOK_LOW", title: "Receipt book low", body: `Only ${remaining} receipt numbers remain`, data: { type: "RECEIPT_BOOK_LOW", repId, receiptBookId: book._id.toString() } });
    });
  }
  return paperReceiptNo;
}

ordersRouter.post("/", requireRole("rep"), validateBody(createOrderSchema), async (req, res) => {
  const repId = req.auth!.id;
  const existing = await Order.findOne({ clientId: req.body.clientId });
  if (existing) {
    if (existing.repId.toString() !== repId) return sendError(res, 409, "DUPLICATE_CLIENT_ID", "This order id is already in use");
    return res.set("Idempotent-Replayed", "true").json(envelope(existing));
  }
  const placedAt = req.body.placedAt ? new Date(req.body.placedAt) : new Date();
  const age = Date.now() - placedAt.getTime();
  if (age < -60_000 || age > BACKDATE_LIMIT_MS) {
    return sendError(res, 422, "VALIDATION_ERROR", "placedAt must be within the last 7 days and not in the future");
  }

  const afterCommit: AfterCommit[] = [];
  let order;
  try {
    order = await runTx(async (session) => {
      afterCommit.length = 0;
      const customer = await Customer.findOne({ _id: req.body.customerId, repId }).session(session);
      if (!customer) throw new ApiError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
      const rep = await User.findById(repId).session(session);
      if (!rep?.repCode) throw new ApiError(422, "REP_CODE_MISSING", "Your account has no rep code");

      const merged = new Map<string, number>();
      for (const line of req.body.items) merged.set(line.productId, (merged.get(line.productId) ?? 0) + line.quantity);

      const products = new Map<string, InstanceType<typeof Product>>();
      const short: Record<string, unknown>[] = [];
      for (const [productId, quantity] of merged) {
        const product = await Product.findById(productId).session(session);
        if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");
        if (!product.isActive) throw new ApiError(422, "PRODUCT_INACTIVE", `${product.name} is no longer sold`);
        products.set(productId, product);
        const available = (await RepStock.findOne({ repId, productId }).session(session))?.quantity ?? 0;
        if (available < quantity) short.push({ productId, name: product.name, requested: quantity, available });
      }
      if (short.length) throw new ApiError(422, "INSUFFICIENT_STOCK", "Insufficient stock", short);

      const items = [];
      for (const [productId, quantity] of merged) {
        const product = products.get(productId)!;
        const stock = await RepStock.findOneAndUpdate({ repId, productId, quantity: { $gte: quantity } }, { $inc: { quantity: -quantity } }, { new: true, session });
        if (!stock) throw new ApiError(422, "INSUFFICIENT_STOCK", "Insufficient stock");
        const before = stock.quantity + quantity;
        if (before > product.lowStockThreshold && stock.quantity <= product.lowStockThreshold) {
          afterCommit.push(() => pushHooks.sendPush([repId], { type: "LOW_STOCK", title: "Low stock", body: `${product.name}: ${stock.quantity} left`, data: { type: "LOW_STOCK", productId, repId } }));
        }
        items.push({ productId: product._id, name: product.name, unitPrice: product.unitPrice, qty: quantity, lineTotal: product.unitPrice * quantity });
      }
      const total = items.reduce((sum, item) => sum + item.lineTotal, 0);

      const dateCode = lagosDateCode(placedAt);
      const receiptNo = req.body.paperReceiptNo
        ? await claimPaperReceipt(repId, req.body.paperReceiptNo, session, afterCommit)
        : `RB-${rep.repCode}-${dateCode}-${String(await nextSequence(`receipt:${rep.repCode}:${dateCode}`, session)).padStart(4, "0")}`;
      const orderNo = `ORD-${rep.repCode}-${dateCode}-${String(await nextSequence(`order:${rep.repCode}:${dateCode}`, session)).padStart(4, "0")}`;

      const [created] = await Order.create([{
        orderNo, receiptNo, clientId: req.body.clientId, repId, customerId: customer._id, items, total,
        paymentMethod: req.body.paymentMethod, note: req.body.note, placedAt, placedHourLagos: lagosHour(placedAt),
      }], { session });
      await StockMovement.insertMany(items.map((item) => ({ type: "SALE", productId: item.productId, repId, quantity: item.qty, orderId: created._id, performedBy: repId })), { session });
      await Customer.updateOne({ _id: customer._id }, { $inc: { orderCount: 1, totalSpent: total }, $max: { lastOrderAt: placedAt } }, { session });
      return created;
    });
  } catch (error) {
    // Two identical submissions raced: return the one that won.
    if ((error as { code?: number }).code === 11000) {
      const replay = await Order.findOne({ clientId: req.body.clientId, repId });
      if (replay) return res.set("Idempotent-Replayed", "true").json(envelope(replay));
    }
    throw error;
  }
  await Promise.allSettled(afterCommit.map((send) => send()));
  res.status(201).json(envelope(order));
});

ordersRouter.get("/", async (req, res) => {
  const isAdmin = req.auth!.role === "admin";
  const query: Record<string, unknown> = isAdmin ? {} : { repId: req.auth!.id };
  const repId = queryString(req.query.repId);
  if (repId && isAdmin) query.repId = repId;
  const customerId = queryString(req.query.customerId);
  if (customerId) query.customerId = customerId;
  const status = queryString(req.query.status);
  if (status) query.status = status;
  const from = queryDate(req.query.from);
  const to = queryDate(req.query.to);
  if (from || to) query.placedAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const q = queryString(req.query.q);
  if (q) {
    const customerIds = await Customer.find({ ...(isAdmin ? {} : { repId: req.auth!.id }), name: searchPattern(q) }).distinct("_id");
    query.$or = [{ orderNo: searchPattern(q) }, { receiptNo: searchPattern(q) }, { customerId: { $in: customerIds } }];
  }
  const meta = listMeta(req.query.page, req.query.limit, await Order.countDocuments(query));
  const items = await Order.find(query).populate("customerId", "name phone").populate("repId", "name repCode").sort({ placedAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  sendList(res, items, meta);
});

ordersRouter.get("/cancelled", requireRole("admin"), async (req, res) => {
  const query: Record<string, unknown> = { status: "CANCELLED" };
  const repId = queryString(req.query.repId);
  if (repId) query.repId = repId;
  const from = queryDate(req.query.from);
  const to = queryDate(req.query.to);
  if (from || to) query.cancelledAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const meta = listMeta(req.query.page, req.query.limit, await Order.countDocuments(query));
  const items = await Order.find(query).populate("repId", "name repCode").populate("customerId", "name phone").populate("cancelledBy", "name role").sort({ cancelledAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  sendList(res, items, meta);
});

const scopedOrder = (req: Express.Request & { params: { id: string } }) => ({ _id: req.params.id, ...(req.auth!.role === "rep" ? { repId: req.auth!.id } : {}) });

ordersRouter.get("/:id", async (req, res) => {
  const order = await Order.findOne(scopedOrder(req)).populate("repId", "name repCode vehicleReg").populate("customerId", "name phone address").lean();
  if (!order) return sendError(res, 404, "NOT_FOUND", "Order not found");
  res.json(envelope(order));
});

ordersRouter.get("/:id/receipt", async (req, res) => {
  const order = await Order.findOne(scopedOrder(req)).populate("repId", "name repCode vehicleReg").populate("customerId", "name phone address").lean();
  if (!order) return sendError(res, 404, "NOT_FOUND", "Order not found");
  const rep = order.repId as unknown as { name?: string; repCode?: string; vehicleReg?: string } | null;
  const customer = order.customerId as unknown as { name?: string; phone?: string; address?: string } | null;
  res.json(envelope({
    orderNo: order.orderNo,
    receiptNo: order.receiptNo,
    status: order.status,
    paymentMethod: order.paymentMethod,
    business: env.business(),
    rep: { name: rep?.name, repCode: rep?.repCode, vehicleReg: rep?.vehicleReg },
    customer: { name: customer?.name, phone: customer?.phone, address: customer?.address },
    items: order.items,
    total: order.total,
    placedAt: order.placedAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
  }));
});

ordersRouter.post("/:id/cancel", validateBody(cancelOrderSchema), async (req, res) => {
  const isAdmin = req.auth!.role === "admin";
  const order = await runTx(async (session) => {
    const claimed = await Order.findOneAndUpdate(
      { _id: req.params.id, status: "COMPLETED", ...(isAdmin ? {} : { repId: req.auth!.id }) },
      { $set: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: req.body.reason, cancelledBy: new mongoose.Types.ObjectId(req.auth!.id) } },
      { new: true, session },
    );
    if (!claimed) {
      const existing = await Order.findOne({ _id: req.params.id, ...(isAdmin ? {} : { repId: req.auth!.id }) }).session(session);
      if (!existing) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");
      throw new ApiError(409, "ORDER_ALREADY_CANCELLED", "Order is already cancelled");
    }
    if (!isAdmin && Date.now() - claimed.placedAt.getTime() > REP_CANCEL_WINDOW_MS) {
      throw new ApiError(422, "CANCEL_WINDOW_EXPIRED", "Orders can only be cancelled within 24 hours");
    }
    for (const item of claimed.items) {
      await RepStock.updateOne({ repId: claimed.repId, productId: item.productId }, { $inc: { quantity: item.qty } }, { upsert: true, session });
    }
    await StockMovement.insertMany(claimed.items.map((item) => ({ type: "CANCEL_RETURN", productId: item.productId, repId: claimed.repId, quantity: item.qty, orderId: claimed._id, performedBy: req.auth!.id, note: req.body.reason })), { session });
    await Customer.updateOne({ _id: claimed.customerId }, { $inc: { orderCount: -1, totalSpent: -claimed.total } }, { session });
    return claimed;
  });
  const message = { type: "ORDER_CANCELLED", title: "Order cancelled", body: `Order ${order.orderNo} was cancelled`, data: { type: "ORDER_CANCELLED", orderId: order._id.toString() } };
  // Notify the admins and, when an admin cancelled it, the rep who placed the order.
  const recipients = [...(await activeAdminIds()).map(String).filter((id) => id !== req.auth!.id), ...(isAdmin ? [order.repId.toString()] : [])];
  await Promise.allSettled([pushHooks.sendPush(recipients, message)]);
  res.json(envelope(order));
});
