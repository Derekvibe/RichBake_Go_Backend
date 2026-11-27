import { AlertState, JobRun, Order, Product, RepStock } from "../models";
import { activeAdminIds, pushHooks } from "../services/push.service";
import { DAY_MS, lagosDateString, lagosDayStart } from "../utils/dates";
import { formatNaira } from "../utils/money";

/**
 * Claims an alert slot atomically: returns true at most once per `key` per 24 hours, even when
 * several API instances run the check at the same moment.
 */
async function claimAlert(key: string, now: Date) {
  const cutoff = new Date(now.getTime() - DAY_MS);
  try {
    const result = await AlertState.updateOne({ key, lastSentAt: { $lt: cutoff } }, { $set: { lastSentAt: now } }, { upsert: true });
    return result.modifiedCount === 1 || result.upsertedCount === 1;
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }
}

/** Sends the admins a summary of one Lagos business day. Idempotent per date. */
export async function runDailySummary(date = lagosDateString()) {
  try {
    await JobRun.create({ key: `daily-summary:${date}` });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return { date, sent: 0, alreadySent: true };
    throw error;
  }
  const start = lagosDayStart(date);
  const end = new Date(start.getTime() + DAY_MS);
  const [totals] = await Order.aggregate([
    { $match: { status: "COMPLETED", placedAt: { $gte: start, $lt: end } } },
    { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 }, units: { $sum: { $sum: "$items.qty" } } } },
  ]);
  const cancellations = await Order.countDocuments({ status: "CANCELLED", cancelledAt: { $gte: start, $lt: end } });
  const data = { revenue: totals?.revenue ?? 0, orders: totals?.orders ?? 0, units: totals?.units ?? 0, cancellations };
  await pushHooks.sendPush(await activeAdminIds(), {
    type: "DAILY_SUMMARY",
    title: "Daily summary",
    body: `${date}: ${data.orders} orders, ${formatNaira(data.revenue)}, ${data.cancellations} cancelled`,
    data: { type: "DAILY_SUMMARY", date },
  });
  return { date, sent: 1, alreadySent: false, ...data };
}

/** Alerts admins about low warehouse stock and reps about their own low stock, at most daily per item. */
export async function runLowStockCheck(now = new Date()) {
  let sent = 0;
  const products = await Product.find({ isActive: true }).lean();
  const admins = await activeAdminIds();
  for (const product of products) {
    if (product.warehouseStock > product.lowStockThreshold) continue;
    if (!(await claimAlert(`warehouse:${product._id}`, now))) continue;
    await pushHooks.sendPush(admins, { type: "LOW_STOCK", title: "Low warehouse stock", body: `${product.name}: ${product.warehouseStock} left in the warehouse`, data: { type: "LOW_STOCK", productId: product._id.toString() } });
    sent++;
  }
  const repStocks = await RepStock.find().populate("productId", "name lowStockThreshold isActive").populate("repId", "name isActive").lean();
  for (const row of repStocks as any[]) {
    if (!row.repId?.isActive || !row.productId?.isActive) continue;
    const threshold = row.productId.lowStockThreshold ?? 10;
    if (row.quantity > threshold) continue;
    if (!(await claimAlert(`rep:${row.repId._id}:${row.productId._id}`, now))) continue;
    await pushHooks.sendPush([row.repId._id], { type: "LOW_STOCK", title: "Low stock", body: `${row.productId.name}: ${row.quantity} left`, data: { type: "LOW_STOCK", repId: row.repId._id.toString(), productId: row.productId._id.toString() } });
    sent++;
  }
  return { checked: products.length + repStocks.length, sent };
}
