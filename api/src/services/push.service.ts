import type mongoose from "mongoose";
import { Expo } from "expo-server-sdk";
import { Notification, User } from "../models";
import { logger } from "../utils/logger";

export type PushMessage = { type?: string; title: string; body: string; data?: Record<string, unknown> };

const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN || undefined });

const PREFERENCE_BY_TYPE: Record<string, string> = {
  ORDER_CANCELLED: "orderCancelled",
  STOCK_ISSUED: "stockIssued",
  LOW_STOCK: "lowStock",
  RECEIPT_BOOK_LOW: "receiptBookLow",
  DAILY_SUMMARY: "dailySummary",
  NEW_ORDER: "newOrder",
  ACCOUNT_ALERT: "accountAlerts",
};

/** Notification types that are off unless the user opts in. */
const OPT_IN_TYPES = new Set(["NEW_ORDER"]);

function linkFor(data: Record<string, unknown> | undefined) {
  if (data?.orderId) return { linkType: "order", linkId: String(data.orderId) };
  if (data?.productId) return { linkType: "product", linkId: String(data.productId) };
  if (data?.repId) return { linkType: "rep", linkId: String(data.repId) };
  return {};
}

/**
 * Stores an in-app notification for each active recipient who has not opted out, then delivers
 * it as a push to their registered devices. Tokens Expo reports as unregistered are removed.
 */
async function sendPush(userIds: Array<mongoose.Types.ObjectId | string>, message: PushMessage) {
  const type = message.type || String(message.data?.type || "");
  const preferenceKey = PREFERENCE_BY_TYPE[type];
  const users = await User.find({ _id: { $in: userIds }, isActive: true }).select("_id pushTokens notificationPrefs").lean();
  for (const user of users) {
    const prefs = user.notificationPrefs instanceof Map
      ? user.notificationPrefs
      : new Map(Object.entries(user.notificationPrefs || {}));
    const preference = preferenceKey ? prefs.get(preferenceKey) : undefined;
    if (preference === false) continue;
    if (OPT_IN_TYPES.has(type) && preference !== true) continue;

    await Notification.create({ userId: user._id, type, title: message.title, body: message.body, data: message.data || {}, ...linkFor(message.data) });

    const tokens = (user.pushTokens || []).filter((token) => Expo.isExpoPushToken(token));
    for (const chunk of expo.chunkPushNotifications(tokens.map((to) => ({ to, sound: "default" as const, title: message.title, body: message.body, data: message.data || {} })))) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        const expired = tickets
          .map((ticket, index) => (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered" ? chunk[index].to : null))
          .flat()
          .filter((token): token is string => typeof token === "string");
        if (expired.length) await User.updateOne({ _id: user._id }, { $pull: { pushTokens: { $in: expired } } });
      } catch (error) {
        logger.warn({ err: error, userId: String(user._id) }, "Push delivery failed");
      }
    }
  }
}

/** Indirection so tests can replace push delivery. */
export const pushHooks = { sendPush };

export async function activeAdminIds() {
  return User.find({ role: "admin", isActive: true }).distinct("_id");
}
