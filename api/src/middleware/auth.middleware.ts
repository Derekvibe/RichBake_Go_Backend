import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { ZodSchema } from "zod";

export type AuthUser = { id: string; role: "admin" | "rep"; name: string };
declare global {
  namespace Express {
    interface Request { auth?: AuthUser }
  }
}

export function auth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (!token) return res.status(401).json({ success: false, data: null, error: { code: "UNAUTHENTICATED", message: "Login required" } });
  try {
    if (!process.env.JWT_ACCESS_SECRET) throw new Error("JWT_ACCESS_SECRET is required");
    req.auth = jwt.verify(token, process.env.JWT_ACCESS_SECRET) as AuthUser;
    next();
  } catch {
    res.status(401).json({ success: false, data: null, error: { code: "INVALID_TOKEN", message: "Token expired or invalid" } });
  }
}

export function requireRole(role: "admin" | "rep") {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.role !== role) return res.status(403).json({ success: false, data: null, error: { code: "FORBIDDEN", message: "Insufficient role" } });
    next();
  };
}

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ success: false, data: null, error: { code: "VALIDATION_ERROR", message: "Invalid request", details: result.error.flatten() } });
    req.body = result.data;
    next();
  };
}
