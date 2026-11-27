import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { paginate, toApiObject } from "./response";

/** Standard success envelope: `{ success, data, error }`. */
export const envelope = (data: unknown) => ({ success: true, data: toApiObject(data as Record<string, unknown>), error: null });

export function sendList(res: Response, items: unknown[], meta: ReturnType<typeof paginate>) {
  res.json({ success: true, data: toApiObject(items as unknown as Record<string, unknown>), meta, error: null });
}

export function sendError(res: Response, status: number, code: string, message: string, details?: unknown) {
  return res.status(status).json({ success: false, data: null, error: { code, message, ...(details ? { details } : {}) } });
}

/** Validates and replaces `req.body` with the parsed (and transformed) value. */
export function validateBody(schema: ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const first = result.error.issues[0];
      const field = first?.path.length ? `${first.path.join(".")}: ` : "";
      return sendError(res, 400, "VALIDATION_ERROR", first ? `${field}${first.message}` : "Invalid request", result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
    }
    req.body = result.data;
    next();
  };
}

/** Returns a query value only when it is a plain string, so `?status[$ne]=x` cannot inject operators. */
export const queryString = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** Escapes user input before it is used in a MongoDB `$regex`, preventing ReDoS and pattern injection. */
export const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const searchPattern = (value: string) => ({ $regex: escapeRegex(value.slice(0, 100)), $options: "i" });

export const listMeta = paginate;

export const normalizePhone = (phone: string) => phone.trim().replace(/[\s-]+/g, "").replace(/^\+?234/, "0");

/** Parses an ISO date query value; returns undefined for anything that is not a valid date. */
export function queryDate(value: unknown): Date | undefined {
  const text = queryString(value);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
