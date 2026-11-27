import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { changePasswordSchema, loginSchema, logoutSchema, pushTokenSchema, refreshSchema, removePushTokenSchema } from "@richbake/shared";
import { User } from "../models";
import { authSelf } from "../middleware/auth.middleware";
import { issueSession, revokeSession, verifyRefreshToken } from "../services/token.service";
import { envelope, normalizePhone, sendError, validateBody } from "../utils/http";

export const authRouter = Router();

const limiterOptions = { standardHeaders: true, legacyHeaders: false, message: { success: false, data: null, error: { code: "RATE_LIMITED", message: "Too many attempts. Try again later." } } } as const;
const loginLimiter = rateLimit({ ...limiterOptions, windowMs: 15 * 60 * 1000, limit: 5 });
const refreshLimiter = rateLimit({ ...limiterOptions, windowMs: 15 * 60 * 1000, limit: 60 });

// Compared against when the phone is unknown so response time does not reveal registered numbers.
const DUMMY_HASH = bcrypt.hashSync("richbake-timing-equaliser", 10);

authRouter.post("/login", loginLimiter, validateBody(loginSchema), async (req, res) => {
  const user = await User.findOne({ phone: normalizePhone(req.body.phone) }).lean();
  const passwordMatches = await bcrypt.compare(req.body.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordMatches || !user.isActive) {
    return sendError(res, 401, "INVALID_CREDENTIALS", "Phone or password is incorrect");
  }
  const tokens = await issueSession(user);
  res.json(envelope({ ...tokens, user: { id: user._id, role: user.role, name: user.name, mustChangePassword: user.mustChangePassword } }));
});

authRouter.post("/refresh", refreshLimiter, validateBody(refreshSchema), async (req, res) => {
  let decoded;
  try {
    decoded = verifyRefreshToken(req.body.refreshToken);
  } catch {
    return sendError(res, 401, "INVALID_REFRESH_TOKEN", "Please log in again");
  }
  const user = await User.findById(decoded.id);
  const valid = user?.isActive && user.refreshTokenHash && user.refreshTokenSessionId === decoded.sessionId
    && await bcrypt.compare(req.body.refreshToken, user.refreshTokenHash);
  if (!user || !valid) {
    // A signed but superseded token means it was reused (possibly stolen): end the session.
    if (user) await revokeSession(user._id.toString());
    return sendError(res, 401, "INVALID_REFRESH_TOKEN", "Please log in again");
  }
  res.json(envelope(await issueSession(user)));
});

authRouter.post("/logout", authSelf, validateBody(logoutSchema), async (req, res) => {
  await revokeSession(req.auth!.id);
  if (req.body.pushToken) await User.updateOne({ _id: req.auth!.id }, { $pull: { pushTokens: req.body.pushToken } });
  res.json(envelope({ loggedOut: true }));
});

authRouter.post("/change-password", authSelf, validateBody(changePasswordSchema), async (req, res) => {
  const user = await User.findById(req.auth!.id);
  if (!user || !(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) {
    return sendError(res, 400, "INVALID_PASSWORD", "Current password is incorrect");
  }
  await User.updateOne({ _id: user._id }, { passwordHash: await bcrypt.hash(req.body.newPassword, 12), mustChangePassword: false });
  res.json(envelope(await issueSession(user)));
});

authRouter.get("/me", authSelf, async (req, res) => {
  const user = await User.findById(req.auth!.id).select("-passwordHash -refreshTokenHash -refreshTokenSessionId -pushTokens").lean();
  if (!user) return sendError(res, 404, "USER_NOT_FOUND", "User not found");
  res.json(envelope(user));
});

authRouter.post("/push-token", authSelf, validateBody(pushTokenSchema), async (req, res) => {
  // A device token belongs to whoever signed in on that device most recently.
  await User.updateMany({ _id: { $ne: req.auth!.id }, pushTokens: req.body.token }, { $pull: { pushTokens: req.body.token } });
  await User.updateOne({ _id: req.auth!.id }, { $addToSet: { pushTokens: req.body.token } });
  res.json(envelope({ registered: true }));
});

authRouter.delete("/push-token", authSelf, validateBody(removePushTokenSchema), async (req, res) => {
  await User.updateOne({ _id: req.auth!.id }, { $pull: { pushTokens: req.body.token } });
  res.json(envelope({ removed: true }));
});
