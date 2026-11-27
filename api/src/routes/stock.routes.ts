import { Router } from "express";
import type { ClientSession } from "mongoose";
import { adjustStockSchema, issueStockSchema, restockSchema, returnStockSchema } from "@richbake/shared";
import { Product, RepStock, StockMovement, User } from "../models";
import { auth, requireRole } from "../middleware/auth.middleware";
import { pushHooks } from "../services/push.service";
import { envelope, listMeta, queryDate, queryString, sendError, sendList, validateBody } from "../utils/http";
import { ApiError, runTx } from "../utils/transactions";

export const stockRouter = Router();
stockRouter.use(auth);

type Item = { productId: string; quantity: number };

/** Combines duplicate product lines so each product is moved once. */
function mergeItems(items: Item[]) {
  const merged = new Map<string, number>();
  for (const item of items) merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  return merged;
}

async function requireActiveRep(repId: string, session?: ClientSession) {
  const rep = await User.findOne({ _id: repId, role: "rep" }).session(session ?? null);
  if (!rep) throw new ApiError(404, "USER_NOT_FOUND", "Rep not found");
  if (!rep.isActive) throw new ApiError(422, "ACCOUNT_INACTIVE", "Rep account is inactive");
  return rep;
}

async function requireProduct(productId: string, session: ClientSession, mustBeActive = true) {
  const product = await Product.findById(productId).session(session);
  if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");
  if (mustBeActive && !product.isActive) throw new ApiError(422, "PRODUCT_INACTIVE", `${product.name} is inactive`);
  return product;
}

const stockView = (row: any) => {
  const threshold = row.productId?.lowStockThreshold ?? 10;
  return {
    productId: row.productId?._id,
    name: row.productId?.name,
    imageUrl: row.productId?.imageUrl,
    unitPrice: row.productId?.unitPrice,
    quantity: row.quantity,
    lowStockThreshold: threshold,
    isLow: row.quantity <= threshold,
  };
};

async function repStockSummary(repId: string) {
  const stock = await RepStock.find({ repId }).populate("productId", "name unitPrice imageUrl lowStockThreshold").lean();
  const items = stock.filter((row) => row.productId).map(stockView).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { repId, totalUnits: items.reduce((sum, row) => sum + row.quantity, 0), items };
}

stockRouter.get("/me", requireRole("rep"), async (req, res) => {
  res.json(envelope(await repStockSummary(req.auth!.id)));
});

stockRouter.get("/reps/:repId", requireRole("admin"), async (req, res) => {
  res.json(envelope(await repStockSummary(String(req.params.repId))));
});

stockRouter.get("/warehouse", requireRole("admin"), async (_req, res) => {
  const products = await Product.find().sort({ name: 1 }).lean();
  res.json(envelope(products.map((product) => ({
    productId: product._id,
    name: product.name,
    imageUrl: product.imageUrl,
    isActive: product.isActive,
    warehouseStock: product.warehouseStock,
    lowStockThreshold: product.lowStockThreshold,
    isLow: product.warehouseStock <= product.lowStockThreshold,
  }))));
});

stockRouter.get("/low", requireRole("admin"), async (_req, res) => {
  const warehouse = (await Product.find({ isActive: true, $expr: { $lte: ["$warehouseStock", "$lowStockThreshold"] } }).sort({ name: 1 }).lean())
    .map((product) => ({ productId: product._id, name: product.name, warehouseStock: product.warehouseStock, threshold: product.lowStockThreshold }));
  const repRows = await RepStock.find().populate("repId", "name repCode isActive").populate("productId", "name lowStockThreshold isActive").lean();
  const reps = (repRows as any[])
    .filter((row) => row.repId?.isActive && row.productId?.isActive && row.quantity <= (row.productId.lowStockThreshold ?? 10))
    .map((row) => ({
      rep: { id: row.repId._id, name: row.repId.name, repCode: row.repId.repCode },
      product: { id: row.productId._id, name: row.productId.name },
      quantity: row.quantity,
      threshold: row.productId.lowStockThreshold ?? 10,
    }));
  res.json(envelope({ warehouse, reps }));
});

stockRouter.get("/movements", requireRole("admin"), async (req, res) => {
  const query: Record<string, unknown> = {};
  for (const key of ["repId", "productId", "type"] as const) {
    const value = queryString(req.query[key]);
    if (value) query[key] = value;
  }
  const from = queryDate(req.query.from);
  const to = queryDate(req.query.to);
  if (from || to) query.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const meta = listMeta(req.query.page, req.query.limit, await StockMovement.countDocuments(query));
  const items = await StockMovement.find(query)
    .populate("productId", "name")
    .populate("repId", "name repCode")
    .populate("performedBy", "name")
    .sort({ createdAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  sendList(res, items, meta);
});

stockRouter.post("/restock", requireRole("admin"), validateBody(restockSchema), async (req, res) => {
  const movements = await runTx(async (session) => {
    const created: Record<string, unknown>[] = [];
    for (const [productId, quantity] of mergeItems(req.body.items)) {
      await requireProduct(productId, session);
      await Product.updateOne({ _id: productId }, { $inc: { warehouseStock: quantity } }, { session });
      created.push({ type: "RESTOCK", productId, quantity, performedBy: req.auth!.id, note: req.body.note });
    }
    await StockMovement.insertMany(created, { session });
    return created;
  });
  res.json(envelope({ movements }));
});

stockRouter.post("/issue", requireRole("admin"), validateBody(issueStockSchema), async (req, res) => {
  const { repId, note } = req.body;
  await requireActiveRep(repId);
  const merged = mergeItems(req.body.items);
  const result = await runTx(async (session) => {
    const short: Record<string, unknown>[] = [];
    for (const [productId, quantity] of merged) {
      const product = await requireProduct(productId, session);
      if (product.warehouseStock < quantity) short.push({ productId: product._id, name: product.name, requested: quantity, available: product.warehouseStock });
    }
    if (short.length) throw new ApiError(422, "INSUFFICIENT_WAREHOUSE_STOCK", "Insufficient warehouse stock", short);
    const repStock: Item[] = [];
    const warehouse: { productId: string; warehouseStock: number }[] = [];
    for (const [productId, quantity] of merged) {
      const product = await Product.findOneAndUpdate({ _id: productId, warehouseStock: { $gte: quantity } }, { $inc: { warehouseStock: -quantity } }, { new: true, session });
      if (!product) throw new ApiError(422, "INSUFFICIENT_WAREHOUSE_STOCK", "Insufficient warehouse stock");
      const row = await RepStock.findOneAndUpdate({ repId, productId }, { $inc: { quantity } }, { upsert: true, new: true, session });
      await StockMovement.create([{ type: "ISSUE_TO_REP", productId, repId, quantity, performedBy: req.auth!.id, note }], { session });
      repStock.push({ productId, quantity: row.quantity });
      warehouse.push({ productId, warehouseStock: product.warehouseStock });
    }
    return { repStock, warehouse };
  });
  await Promise.allSettled([
    pushHooks.sendPush([repId], { type: "STOCK_ISSUED", title: "Stock issued", body: "Your stock allocation has been updated", data: { type: "STOCK_ISSUED", repId } }),
  ]);
  res.json(envelope(result));
});

stockRouter.post("/return", requireRole("admin"), validateBody(returnStockSchema), async (req, res) => {
  const { repId, note } = req.body;
  if (!(await User.exists({ _id: repId, role: "rep" }))) return sendError(res, 404, "USER_NOT_FOUND", "Rep not found");
  const merged = mergeItems(req.body.items);
  const result = await runTx(async (session) => {
    const repStock: Item[] = [];
    const warehouse: { productId: string; warehouseStock: number }[] = [];
    for (const [productId, quantity] of merged) {
      const row = await RepStock.findOneAndUpdate({ repId, productId, quantity: { $gte: quantity } }, { $inc: { quantity: -quantity } }, { new: true, session });
      if (!row) throw new ApiError(422, "INSUFFICIENT_REP_STOCK", "Insufficient rep stock");
      const product = await Product.findOneAndUpdate({ _id: productId }, { $inc: { warehouseStock: quantity } }, { new: true, session });
      if (!product) throw new ApiError(404, "PRODUCT_NOT_FOUND", "Product not found");
      await StockMovement.create([{ type: "RETURN_TO_WAREHOUSE", productId, repId, quantity, performedBy: req.auth!.id, note }], { session });
      repStock.push({ productId, quantity: row.quantity });
      warehouse.push({ productId, warehouseStock: product.warehouseStock });
    }
    return { repStock, warehouse };
  });
  res.json(envelope(result));
});

stockRouter.post("/adjust", requireRole("admin"), validateBody(adjustStockSchema), async (req, res) => {
  const items: Array<Item & { repId?: string }> = req.body.items;
  await runTx(async (session) => {
    for (const item of items) {
      await requireProduct(item.productId, session, false);
      if (item.repId) {
        if (!(await User.exists({ _id: item.repId, role: "rep" }).session(session))) throw new ApiError(404, "USER_NOT_FOUND", "Rep not found");
        const row = await RepStock.findOne({ repId: item.repId, productId: item.productId }).session(session);
        const next = (row?.quantity ?? 0) + item.quantity;
        if (next < 0) throw new ApiError(422, "INSUFFICIENT_STOCK", "Adjustment would make rep stock negative");
        await RepStock.updateOne({ repId: item.repId, productId: item.productId }, { $set: { quantity: next } }, { upsert: true, session });
      } else {
        const updated = await Product.updateOne(
          { _id: item.productId, warehouseStock: { $gte: Math.max(0, -item.quantity) } },
          { $inc: { warehouseStock: item.quantity } },
          { session },
        );
        if (updated.modifiedCount !== 1) throw new ApiError(422, "INSUFFICIENT_STOCK", "Adjustment would make warehouse stock negative");
      }
      await StockMovement.create([{ type: "ADJUSTMENT", productId: item.productId, repId: item.repId, quantity: item.quantity, performedBy: req.auth!.id, note: req.body.reason }], { session });
    }
  });
  res.json(envelope({ adjusted: items.length }));
});
