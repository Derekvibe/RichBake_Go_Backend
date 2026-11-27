import { Router } from "express";
import mongoose from "mongoose";
import { Customer, Order, Product, RepStock, User } from "../models";
import { auth, requireRole } from "../middleware/auth.middleware";
import { DAY_MS, LAGOS_TZ, lagosDateString, lagosDayStart, lagosMidnightUtc, lagosRange } from "../utils/dates";
import { envelope, queryString, sendError } from "../utils/http";

export const reportsRouter = Router();
reportsRouter.use(auth);

type Unit = "hour" | "day" | "week" | "month";
const KEY_FORMATS: Record<Unit, string> = { hour: "%Y-%m-%dT%H:00", day: "%Y-%m-%d", week: "%Y-%m-%d", month: "%Y-%m" };

const clampLimit = (value: unknown, fallback: number) => Math.min(100, Math.max(1, Number(value) || fallback));
const toObjectId = (value: string) => new mongoose.Types.ObjectId(value);

/** Every bucket key between `from` and `to`, so empty hours/days/months show as zero. */
function bucketKeys(unit: Unit, from: Date, to: Date): string[] {
  if (to.getTime() - from.getTime() > 400 * DAY_MS) return [];
  const keys: string[] = [];
  if (unit === "hour") {
    for (let time = from.getTime(); time < to.getTime(); time += 60 * 60 * 1000) {
      const date = new Date(time);
      const hour = new Intl.DateTimeFormat("en-GB", { timeZone: LAGOS_TZ, hour: "2-digit", hourCycle: "h23" }).format(date);
      keys.push(`${lagosDateString(date)}T${hour}:00`);
    }
  } else if (unit === "day") {
    for (let time = from.getTime(); time < to.getTime(); time += DAY_MS) keys.push(lagosDateString(new Date(time)));
  } else if (unit === "month") {
    for (let time = from.getTime(); time < to.getTime(); time += DAY_MS) {
      const key = lagosDateString(new Date(time)).slice(0, 7);
      if (keys[keys.length - 1] !== key) keys.push(key);
    }
  }
  return keys;
}

async function buildSalesReport(match: Record<string, unknown>, reqQuery: Record<string, unknown>) {
  const range = lagosRange(reqQuery.period, reqQuery.from, reqQuery.to);
  const defaultUnit: Unit = range.period === "today" ? "hour" : range.period === "year" || range.period === "all" ? "month" : "day";
  const requested = queryString(reqQuery.groupBy) as Unit | undefined;
  const unit: Unit = requested && requested in KEY_FORMATS ? requested : defaultUnit;
  const completed = { ...match, status: "COMPLETED", placedAt: { $gte: range.from, $lt: range.to } };

  const [totalsRows, seriesRows, productRows, cancelledOrders] = await Promise.all([
    Order.aggregate([
      { $match: completed },
      { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 }, units: { $sum: { $sum: "$items.qty" } } } },
    ]),
    Order.aggregate([
      { $match: completed },
      { $group: {
        // Keys are formatted in Lagos time; formatting the UTC instant would shift days back by one.
        _id: { $dateToString: { date: { $dateTrunc: { date: "$placedAt", unit, timezone: LAGOS_TZ, startOfWeek: "monday" } }, format: KEY_FORMATS[unit], timezone: LAGOS_TZ } },
        revenue: { $sum: "$total" },
        orders: { $sum: 1 },
      } },
      { $sort: { _id: 1 } },
    ]),
    Order.aggregate([
      { $match: completed },
      { $unwind: "$items" },
      { $group: { _id: "$items.productId", name: { $last: "$items.name" }, units: { $sum: "$items.qty" }, revenue: { $sum: "$items.lineTotal" } } },
      { $sort: { revenue: -1 } },
    ]),
    Order.countDocuments({ ...match, status: "CANCELLED", cancelledAt: { $gte: range.from, $lt: range.to } }),
  ]);

  const totals = totalsRows[0] ?? { revenue: 0, orders: 0, units: 0 };
  const byKey = new Map(seriesRows.map((row) => [row._id as string, row]));
  const keys = bucketKeys(unit, range.from, range.to);
  const series = (keys.length ? keys : [...byKey.keys()]).map((key) => ({ key, revenue: byKey.get(key)?.revenue ?? 0, orders: byKey.get(key)?.orders ?? 0 }));

  return {
    period: {
      from: range.period === "all" ? null : lagosDateString(range.from),
      to: lagosDateString(new Date(range.to.getTime() - 1)),
      label: range.period,
      groupBy: unit,
    },
    totals: {
      revenue: totals.revenue,
      orders: totals.orders,
      units: totals.units,
      cancelledOrders,
      averageOrderValue: totals.orders ? Math.round(totals.revenue / totals.orders) : 0,
    },
    series,
    byProduct: productRows.map((row) => ({ productId: row._id, name: row.name, units: row.units, revenue: row.revenue })),
  };
}

/** Orders do not store an area, so an area filter is resolved to the reps assigned to it. */
async function areaMatch(area: string | undefined): Promise<Record<string, unknown>> {
  if (!area) return {};
  return { repId: { $in: await User.find({ role: "rep", area }).distinct("_id") } };
}

reportsRouter.get("/sales/me", requireRole("rep"), async (req, res) => {
  res.json(envelope(await buildSalesReport({ repId: toObjectId(req.auth!.id) }, req.query)));
});

reportsRouter.get("/sales/reps/:repId", requireRole("admin"), async (req, res) => {
  if (!mongoose.isValidObjectId(String(req.params.repId))) return sendError(res, 400, "INVALID_ID", "Invalid rep id");
  res.json(envelope(await buildSalesReport({ repId: toObjectId(String(req.params.repId)) }, req.query)));
});

reportsRouter.get("/sales/overview", requireRole("admin"), async (req, res) => {
  res.json(envelope(await buildSalesReport(await areaMatch(queryString(req.query.area)), req.query)));
});

reportsRouter.get("/leaderboard/reps", requireRole("admin"), async (req, res) => {
  const range = lagosRange(req.query.period, req.query.from, req.query.to);
  const metric = ["revenue", "orders", "units"].includes(String(req.query.metric)) ? String(req.query.metric) : "revenue";
  const sort: Record<string, Record<string, 1 | -1>> = {
    revenue: { revenue: -1, orders: -1, _id: 1 },
    orders: { orders: -1, revenue: -1, _id: 1 },
    units: { units: -1, revenue: -1, _id: 1 },
  };
  const data = await Order.aggregate([
    { $match: { ...(await areaMatch(queryString(req.query.area))), status: "COMPLETED", placedAt: { $gte: range.from, $lt: range.to } } },
    { $group: { _id: "$repId", revenue: { $sum: "$total" }, orders: { $sum: 1 }, units: { $sum: { $sum: "$items.qty" } } } },
    { $sort: sort[metric] },
    { $limit: clampLimit(req.query.limit, 10) },
    { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "rep" } },
    { $unwind: "$rep" },
  ]);
  res.json(envelope({
    period: range.period,
    metric,
    items: data.map((row, index) => ({
      rank: index + 1,
      rep: { id: row._id, name: row.rep.name, repCode: row.rep.repCode },
      revenue: row.revenue,
      orders: row.orders,
      units: row.units,
    })),
  }));
});

reportsRouter.get("/customers/top", async (req, res) => {
  const repIdQuery = queryString(req.query.repId);
  if (req.auth!.role === "rep" && repIdQuery) return sendError(res, 403, "FORBIDDEN", "A rep cannot query another rep");
  // Admins see all customers unless they filter by rep; reps only ever see their own.
  const filter = req.auth!.role === "admin" ? (repIdQuery ? { repId: repIdQuery } : {}) : { repId: req.auth!.id };
  const customers = await Customer.find({ ...filter, orderCount: { $gt: 0 } }).populate("repId", "name repCode").sort({ totalSpent: -1, _id: 1 }).limit(clampLimit(req.query.limit, 10)).lean();
  res.json(envelope({
    items: customers.map((customer, index) => {
      const rep = customer.repId as unknown as { _id: unknown; name?: string; repCode?: string } | null;
      return {
        rank: index + 1,
        customer: { id: customer._id, name: customer.name, phone: customer.phone },
        rep: rep ? { id: rep._id, name: rep.name, repCode: rep.repCode } : null,
        orders: customer.orderCount,
        totalSpent: customer.totalSpent,
        lastOrderAt: customer.lastOrderAt,
      };
    }),
  }));
});

reportsRouter.get("/customers/preferred-time", async (req, res) => {
  const repIdQuery = queryString(req.query.repId);
  const repId = req.auth!.role === "admin" && repIdQuery ? repIdQuery : req.auth!.id;
  const customerId = queryString(req.query.customerId);
  if (!mongoose.isValidObjectId(repId) || (customerId && !mongoose.isValidObjectId(customerId))) return sendError(res, 400, "INVALID_ID", "Invalid id");
  const match: Record<string, unknown> = { repId: toObjectId(repId), status: "COMPLETED" };
  if (customerId) match.customerId = toObjectId(customerId);
  const from = queryString(req.query.from);
  const to = queryString(req.query.to);
  const isDate = (value?: string) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (isDate(from) || isDate(to)) {
    match.placedAt = {
      ...(isDate(from) ? { $gte: lagosDayStart(from!) } : {}),
      ...(isDate(to) ? { $lt: new Date(lagosDayStart(to!).getTime() + DAY_MS) } : {}),
    };
  }
  const rows = await Order.aggregate([{ $match: match }, { $group: { _id: "$placedHourLagos", orders: { $sum: 1 } } }]);
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: rows.find((row) => row._id === hour)?.orders ?? 0 }));
  let bestStart = 0;
  let bestTotal = -1;
  for (let start = 0; start < 24; start++) {
    const total = hours[start].orders + hours[(start + 1) % 24].orders;
    if (total > bestTotal) { bestTotal = total; bestStart = start; }
  }
  const sum = (list: typeof hours) => list.reduce((total, row) => total + row.orders, 0);
  const sampleSize = sum(hours);
  const pad = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  res.json(envelope({
    customerId: customerId ?? null,
    sampleSize,
    enoughData: sampleSize >= 3,
    hours,
    topWindow: { startHour: bestStart, endHour: (bestStart + 2) % 24, orders: bestTotal, label: `${pad(bestStart)} - ${pad((bestStart + 2) % 24)}` },
    buckets: {
      morning: sum(hours.slice(6, 12)),
      afternoon: sum(hours.slice(12, 17)),
      evening: sum(hours.slice(17, 21)),
      night: sum(hours.filter((row) => row.hour < 6 || row.hour >= 21)),
    },
  }));
});

reportsRouter.get("/products/top", requireRole("admin"), async (req, res) => {
  const range = lagosRange(req.query.period ?? "all", req.query.from, req.query.to);
  const data = await Order.aggregate([
    { $match: { status: "COMPLETED", placedAt: { $gte: range.from, $lt: range.to } } },
    { $unwind: "$items" },
    { $group: { _id: "$items.productId", name: { $last: "$items.name" }, units: { $sum: "$items.qty" }, revenue: { $sum: "$items.lineTotal" } } },
    { $sort: { revenue: -1, _id: 1 } },
    { $limit: clampLimit(req.query.limit, 10) },
  ]);
  res.json(envelope({ period: range.period, items: data.map((row) => ({ productId: row._id, name: row.name, units: row.units, revenue: row.revenue })) }));
});

reportsRouter.get("/dashboard", requireRole("admin"), async (_req, res) => {
  const todayStart = lagosMidnightUtc();
  const todayEnd = new Date(todayStart.getTime() + DAY_MS);
  const trendStart = new Date(todayStart.getTime() - 6 * DAY_MS);
  const todayMatch = { status: "COMPLETED", placedAt: { $gte: todayStart, $lt: todayEnd } };
  const [today, cancelled, trend, topRep, lowStockCount, recentCancelled, activeReps] = await Promise.all([
    Order.aggregate([{ $match: todayMatch }, { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 }, units: { $sum: { $sum: "$items.qty" } } } }]),
    Order.countDocuments({ status: "CANCELLED", cancelledAt: { $gte: todayStart, $lt: todayEnd } }),
    Order.aggregate([
      { $match: { status: "COMPLETED", placedAt: { $gte: trendStart, $lt: todayEnd } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$placedAt", timezone: LAGOS_TZ } }, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: todayMatch },
      { $group: { _id: "$repId", revenue: { $sum: "$total" } } },
      { $sort: { revenue: -1 } }, { $limit: 1 },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "rep" } }, { $unwind: "$rep" },
    ]),
    Product.countDocuments({ isActive: true, $expr: { $lte: ["$warehouseStock", "$lowStockThreshold"] } }),
    Order.find({ status: "CANCELLED" }).populate("repId", "name repCode").populate("customerId", "name").sort({ cancelledAt: -1 }).limit(3).lean(),
    User.countDocuments({ role: "rep", isActive: true }),
  ]);
  const trendByDay = new Map(trend.map((row) => [row._id as string, row]));
  res.json(envelope({
    today: { revenue: today[0]?.revenue ?? 0, orders: today[0]?.orders ?? 0, units: today[0]?.units ?? 0, cancelledOrders: cancelled, activeReps },
    // Always seven Lagos days ending today, including days with no sales.
    trend: bucketKeys("day", trendStart, todayEnd).map((date) => ({ date, revenue: trendByDay.get(date)?.revenue ?? 0, orders: trendByDay.get(date)?.orders ?? 0 })),
    topRepToday: topRep[0] ? { rep: { id: topRep[0]._id, name: topRep[0].rep.name, repCode: topRep[0].rep.repCode }, revenue: topRep[0].revenue } : null,
    lowStockCount,
    recentCancelled,
  }));
});

reportsRouter.get("/home/me", requireRole("rep"), async (req, res) => {
  const repId = toObjectId(req.auth!.id);
  const todayStart = lagosMidnightUtc();
  const [today, stock, lastOrders] = await Promise.all([
    Order.aggregate([
      { $match: { repId, status: "COMPLETED", placedAt: { $gte: todayStart, $lt: new Date(todayStart.getTime() + DAY_MS) } } },
      { $group: { _id: null, revenue: { $sum: "$total" }, orders: { $sum: 1 }, units: { $sum: { $sum: "$items.qty" } } } },
    ]),
    RepStock.find({ repId }).populate("productId", "name lowStockThreshold").lean(),
    Order.find({ repId }).populate("customerId", "name").sort({ placedAt: -1 }).limit(3).lean(),
  ]);
  const rows = (stock as any[]).filter((row) => row.productId);
  res.json(envelope({
    today: { revenue: today[0]?.revenue ?? 0, orders: today[0]?.orders ?? 0, units: today[0]?.units ?? 0 },
    stockUnits: rows.reduce((sum, row) => sum + row.quantity, 0),
    lowStockItems: rows.filter((row) => row.quantity <= (row.productId.lowStockThreshold ?? 10)).map((row) => ({ productId: row.productId._id, name: row.productId.name, quantity: row.quantity })),
    lastOrders,
  }));
});
