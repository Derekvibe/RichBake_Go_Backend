import { Router } from "express";
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { dailySummaryJobSchema } from "@richbake/shared";
import { env } from "../config/env";
import { runDailySummary, runLowStockCheck } from "../jobs/jobs.service";
import { envelope, sendError, validateBody } from "../utils/http";

/**
 * Manual / external triggers for the background jobs. The built-in scheduler runs them
 * automatically; these endpoints stay closed unless CRON_SECRET is configured.
 */
export const jobsRouter = Router();

function requireCronSecret(req: Request, res: Response, next: NextFunction) {
  const expected = env.cronSecret();
  const provided = req.headers["x-cron-secret"];
  const valid = Boolean(expected) && typeof provided === "string"
    && Buffer.byteLength(provided) === Buffer.byteLength(expected)
    && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!valid) return sendError(res, 401, "INVALID_CRON_SECRET", "Invalid cron secret");
  next();
}

jobsRouter.use(requireCronSecret);

jobsRouter.post("/daily-summary", validateBody(dailySummaryJobSchema), async (req, res) => {
  res.json(envelope(await runDailySummary(req.body.date)));
});

jobsRouter.post("/low-stock-check", async (_req, res) => {
  res.json(envelope(await runLowStockCheck()));
});
