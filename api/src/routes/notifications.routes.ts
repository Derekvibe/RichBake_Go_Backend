import { Router } from "express";
import { NOTIFICATION_PREFERENCE_KEYS, notificationPreferencesSchema } from "@richbake/shared";
import { Notification, User } from "../models";
import { auth } from "../middleware/auth.middleware";
import { envelope, listMeta, sendError, sendList, validateBody } from "../utils/http";

export const notificationsRouter = Router();
notificationsRouter.use(auth);

const DEFAULT_PREFERENCES: Record<(typeof NOTIFICATION_PREFERENCE_KEYS)[number], boolean> = {
  orderCancelled: true,
  stockIssued: true,
  lowStock: true,
  receiptBookLow: true,
  dailySummary: true,
  newOrder: false,
  accountAlerts: true,
};

async function preferencesFor(userId: string) {
  const user = await User.findById(userId).select("notificationPrefs").lean();
  const stored = user?.notificationPrefs instanceof Map ? Object.fromEntries(user.notificationPrefs) : (user?.notificationPrefs ?? {});
  return Object.fromEntries(NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, typeof stored[key] === "boolean" ? stored[key] : DEFAULT_PREFERENCES[key]]));
}

notificationsRouter.get("/", async (req, res) => {
  const filter = { userId: req.auth!.id };
  const meta = listMeta(req.query.page, req.query.limit, await Notification.countDocuments(filter));
  const items = await Notification.find(filter).sort({ createdAt: -1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  sendList(res, items, meta);
});

notificationsRouter.get("/unread-count", async (req, res) => {
  res.json(envelope({ count: await Notification.countDocuments({ userId: req.auth!.id, readAt: { $exists: false } }) }));
});

notificationsRouter.post("/read-all", async (req, res) => {
  const result = await Notification.updateMany({ userId: req.auth!.id, readAt: { $exists: false } }, { $set: { readAt: new Date() } });
  res.json(envelope({ updated: result.modifiedCount }));
});

notificationsRouter.get("/preferences", async (req, res) => {
  res.json(envelope(await preferencesFor(req.auth!.id)));
});

notificationsRouter.patch("/preferences", validateBody(notificationPreferencesSchema), async (req, res) => {
  const updates = Object.entries(req.body as Record<string, boolean | undefined>).filter(([, value]) => typeof value === "boolean");
  if (updates.length) {
    await User.updateOne({ _id: req.auth!.id }, { $set: Object.fromEntries(updates.map(([key, value]) => [`notificationPrefs.${key}`, value])) });
  }
  res.json(envelope(await preferencesFor(req.auth!.id)));
});

notificationsRouter.patch("/:id/read", async (req, res) => {
  const notification = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.auth!.id }, { $set: { readAt: new Date() } }, { new: true });
  if (!notification) return sendError(res, 404, "NOT_FOUND", "Notification not found");
  res.json(envelope(notification));
});
