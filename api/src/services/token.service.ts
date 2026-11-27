import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { User } from "../models";
import type { Role } from "../middleware/auth.middleware";

const ACCESS_TTL = "15m";
const REFRESH_TTL = "30d";

export type RefreshPayload = { id: string; role: Role; name: string; sessionId: string };

/**
 * Issues an access/refresh pair and stores a hash of the refresh token with its session id.
 * Only the most recent refresh token is valid; presenting an older one revokes the session.
 */
export async function issueSession(user: { _id: { toString(): string }; role: string; name: string }) {
  const payload = { id: user._id.toString(), role: user.role as Role, name: user.name };
  const sessionId = crypto.randomUUID();
  const accessToken = jwt.sign(payload, env.jwtAccessSecret(), { expiresIn: ACCESS_TTL, algorithm: "HS256" });
  const refreshToken = jwt.sign({ ...payload, sessionId }, env.jwtRefreshSecret(), { expiresIn: REFRESH_TTL, algorithm: "HS256" });
  await User.updateOne({ _id: payload.id }, { refreshTokenHash: await bcrypt.hash(refreshToken, 10), refreshTokenSessionId: sessionId });
  return { accessToken, refreshToken };
}

export function verifyRefreshToken(token: string) {
  return jwt.verify(token, env.jwtRefreshSecret(), { algorithms: ["HS256"] }) as RefreshPayload;
}

export async function revokeSession(userId: string) {
  await User.updateOne({ _id: userId }, { $unset: { refreshTokenHash: 1, refreshTokenSessionId: 1 } });
}

const ALPHABET_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
const ALPHABET_DIGITS = "23456789";

/** 10-character temporary password with at least one letter and one digit, from a CSPRNG. */
export function generateTemporaryPassword() {
  const alphabet = ALPHABET_LETTERS + ALPHABET_DIGITS;
  const chars = Array.from({ length: 8 }, () => alphabet[crypto.randomInt(alphabet.length)]);
  chars.push(ALPHABET_LETTERS[crypto.randomInt(ALPHABET_LETTERS.length)], ALPHABET_DIGITS[crypto.randomInt(ALPHABET_DIGITS.length)]);
  for (let index = chars.length - 1; index > 0; index--) {
    const swap = crypto.randomInt(index + 1);
    [chars[index], chars[swap]] = [chars[swap], chars[index]];
  }
  return chars.join("");
}
