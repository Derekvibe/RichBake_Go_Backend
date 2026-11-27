import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { User } from "../models";
import { sendError } from "../utils/http";

export type Role = "admin" | "rep";
export type AuthUser = { id: string; role: Role; name: string };

declare global {
  namespace Express {
    interface Request { auth?: AuthUser }
  }
}

async function authenticate(req: Request, res: Response, next: NextFunction, allowPendingPasswordChange: boolean) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) return sendError(res, 401, "UNAUTHENTICATED", "Login required");
  let payload: { id?: unknown };
  try {
    payload = jwt.verify(token, env.jwtAccessSecret(), { algorithms: ["HS256"] }) as { id?: unknown };
  } catch {
    return sendError(res, 401, "INVALID_TOKEN", "Token expired or invalid");
  }
  if (typeof payload.id !== "string") return sendError(res, 401, "INVALID_TOKEN", "Token expired or invalid");
  const user = await User.findById(payload.id).select("_id role name isActive mustChangePassword").lean();
  if (!user || !user.isActive) return sendError(res, 403, "ACCOUNT_INACTIVE", "Account is inactive");
  if (user.mustChangePassword && !allowPendingPasswordChange) {
    return sendError(res, 403, "PASSWORD_CHANGE_REQUIRED", "Change your password to continue");
  }
  // Role and name come from the database so a stale token can never carry outdated privileges.
  req.auth = { id: user._id.toString(), role: user.role as Role, name: user.name };
  next();
}

/** Requires a valid access token for an active user who has completed any required password change. */
export function auth(req: Request, res: Response, next: NextFunction) {
  return authenticate(req, res, next, false);
}

/** Like `auth`, but also admits users who still have to change their temporary password. */
export function authSelf(req: Request, res: Response, next: NextFunction) {
  return authenticate(req, res, next, true);
}

export function requireRole(role: Role) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.role !== role) return sendError(res, 403, "FORBIDDEN", "Insufficient role");
    next();
  };
}
