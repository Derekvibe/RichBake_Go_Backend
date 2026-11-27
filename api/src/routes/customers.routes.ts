import { Router } from "express";
import { customerSchema, updateCustomerSchema } from "@richbake/shared";
import { Customer, Order } from "../models";
import { auth, requireRole } from "../middleware/auth.middleware";
import { envelope, listMeta, normalizePhone, queryString, searchPattern, sendError, sendList, validateBody } from "../utils/http";

export const customersRouter = Router();
customersRouter.use(auth);

const SORTS: Record<string, Record<string, 1 | -1>> = {
  spent: { totalSpent: -1 },
  recent: { lastOrderAt: -1 },
  name: { name: 1 },
};

customersRouter.post("/", requireRole("rep"), validateBody(customerSchema), async (req, res) => {
  const repId = req.auth!.id;
  if (req.body.clientId) {
    const existing = await Customer.findOne({ clientId: req.body.clientId, repId });
    if (existing) return res.set("Idempotent-Replayed", "true").json(envelope(existing));
  }
  const phone = normalizePhone(req.body.phone);
  const duplicate = await Customer.findOne({ repId, phone });
  if (duplicate) return sendError(res, 409, "CUSTOMER_PHONE_EXISTS", "A customer with this phone number already exists", [{ existingCustomerId: duplicate._id.toString() }]);
  try {
    const customer = await Customer.create({ ...req.body, phone, repId });
    res.status(201).json(envelope(customer));
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const replay = req.body.clientId ? await Customer.findOne({ repId, clientId: req.body.clientId }) : null;
    if (replay) return res.set("Idempotent-Replayed", "true").json(envelope(replay));
    return sendError(res, 409, "CUSTOMER_PHONE_EXISTS", "A customer with this phone number already exists");
  }
});

customersRouter.get("/", async (req, res) => {
  const query: Record<string, unknown> = req.auth!.role === "admin" ? {} : { repId: req.auth!.id };
  const q = queryString(req.query.q);
  if (q) query.$or = [{ name: searchPattern(q) }, { phone: searchPattern(q) }];
  const repId = queryString(req.query.repId);
  if (repId && req.auth!.role === "admin") query.repId = repId;
  const meta = listMeta(req.query.page, req.query.limit, await Customer.countDocuments(query));
  const sort = SORTS[queryString(req.query.sort) ?? "name"] ?? SORTS.name;
  const customers = await Customer.find(query).sort(sort).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  sendList(res, customers, meta);
});

customersRouter.get("/:id", async (req, res) => {
  const customer = await Customer.findOne({ _id: req.params.id, ...(req.auth!.role === "rep" ? { repId: req.auth!.id } : {}) }).lean();
  if (!customer) return sendError(res, 404, "NOT_FOUND", "Customer not found");
  const orders = await Order.find({ customerId: customer._id }).sort({ placedAt: -1 }).limit(10).lean();
  res.json(envelope({
    customer,
    recentOrders: orders.map((order) => ({
      id: order._id,
      orderNo: order.orderNo,
      receiptNo: order.receiptNo,
      status: order.status,
      total: order.total,
      itemCount: order.items?.length ?? 0,
      placedAt: order.placedAt,
    })),
  }));
});

// Only contact details are editable, so a rep cannot rewrite repId, orderCount or totalSpent.
customersRouter.patch("/:id", requireRole("rep"), validateBody(updateCustomerSchema), async (req, res) => {
  const update = { ...req.body, ...(req.body.phone ? { phone: normalizePhone(req.body.phone) } : {}) };
  const customer = await Customer.findOneAndUpdate({ _id: req.params.id, repId: req.auth!.id }, { $set: update }, { new: true, runValidators: true });
  if (!customer) return sendError(res, 404, "NOT_FOUND", "Customer not found");
  res.json(envelope(customer));
});
