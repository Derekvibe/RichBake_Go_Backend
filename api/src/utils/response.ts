import mongoose from "mongoose";

export function toApiObject<T extends Record<string, any>>(value: T): Record<string, any> {
  if (value instanceof mongoose.Types.ObjectId) return String(value) as any;
  if (Array.isArray(value)) return value.map((item) => toApiObject(item)) as any;
  if (!value || typeof value !== "object") return value as any;
  if (typeof (value as any).toObject === "function") value = (value as any).toObject();
  if (value instanceof Date) return value as any;
  const result: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "_id" || key === "__v") continue;
    result[key === "_id" ? "id" : key] = Array.isArray(item)
      ? item.map((entry) => typeof entry === "object" ? toApiObject(entry) : entry)
      : item && typeof item === "object" && !(item instanceof Date)
        ? toApiObject(item)
        : item;
  }
  if (value._id && !result.id) result.id = String(value._id);
  return result;
}

export function paginate(pageValue: unknown, limitValue: unknown, total: number) {
  const page = Math.max(1, Number(pageValue) || 1);
  const limit = Math.min(100, Math.max(1, Number(limitValue) || 20));
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}
