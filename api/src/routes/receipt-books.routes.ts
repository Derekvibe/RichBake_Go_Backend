import { Router } from "express";
import { createReceiptBookSchema, voidReceiptBookSchema } from "@richbake/shared";
import { ReceiptBook, User } from "../models";
import { auth, requireRole } from "../middleware/auth.middleware";
import { envelope, listMeta, queryString, sendError, sendList, validateBody } from "../utils/http";

export const receiptBooksRouter = Router();
receiptBooksRouter.use(auth);

type BookLike = { startNo: number; endNo: number; nextNo: number; status: string };

/** Adds usage counts so the app does not have to derive them. */
const withUsage = <T extends BookLike>(book: T) => ({
  ...book,
  usedCount: Math.min(book.endNo - book.startNo + 1, Math.max(0, book.nextNo - book.startNo)),
  remaining: book.status === "ACTIVE" ? Math.max(0, book.endNo - book.nextNo + 1) : 0,
});

receiptBooksRouter.post("/", requireRole("admin"), validateBody(createReceiptBookSchema), async (req, res) => {
  const { repId, startNo, endNo, prefix } = req.body;
  if (!(await User.exists({ _id: repId, role: "rep", isActive: true }))) return sendError(res, 404, "USER_NOT_FOUND", "Active rep not found");
  const overlap = await ReceiptBook.exists({ prefix, status: { $in: ["ACTIVE", "FULL"] }, startNo: { $lte: endNo }, endNo: { $gte: startNo } });
  if (overlap) return sendError(res, 409, "RANGE_OVERLAP", "This range overlaps a receipt book that is already assigned");
  const book = await ReceiptBook.create({ repId, prefix, startNo, endNo, nextNo: startNo, assignedBy: req.auth!.id });
  res.status(201).json(envelope({ id: book._id, repId: book.repId, prefix: book.prefix, startNo, endNo, usedCount: 0, remaining: endNo - startNo + 1, status: book.status }));
});

receiptBooksRouter.get("/", requireRole("admin"), async (req, res) => {
  const query: Record<string, unknown> = {};
  const repId = queryString(req.query.repId);
  if (repId) query.repId = repId;
  const status = queryString(req.query.status);
  if (status) query.status = status;
  const meta = listMeta(req.query.page, req.query.limit, await ReceiptBook.countDocuments(query));
  const items = await ReceiptBook.find(query).populate("repId", "name repCode").sort({ assignedAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  sendList(res, items.map(withUsage), meta);
});

receiptBooksRouter.get("/me", requireRole("rep"), async (req, res) => {
  const books = await ReceiptBook.find({ repId: req.auth!.id, status: "ACTIVE" }).sort({ nextNo: 1 }).lean();
  res.json(envelope(books.map(withUsage)));
});

receiptBooksRouter.patch("/:id/void", requireRole("admin"), validateBody(voidReceiptBookSchema), async (req, res) => {
  const book = await ReceiptBook.findOneAndUpdate({ _id: req.params.id, status: "ACTIVE" }, { status: "VOIDED", voidReason: req.body.reason || "Voided by admin" }, { new: true });
  if (!book) return sendError(res, 404, "NOT_FOUND", "Active receipt book not found");
  res.json(envelope(book));
});
