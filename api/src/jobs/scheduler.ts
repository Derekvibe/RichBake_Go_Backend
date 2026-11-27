import cron, { type ScheduledTask } from "node-cron";
import { env } from "../config/env";
import { LAGOS_TZ } from "../utils/dates";
import { logger } from "../utils/logger";
import { runDailySummary, runLowStockCheck } from "./jobs.service";

/**
 * In-process scheduler for the background jobs. Both jobs are idempotent (JobRun / AlertState),
 * so running several API instances cannot send duplicate notifications.
 */
export function startScheduler(): ScheduledTask[] {
  if (!env.schedulerEnabled()) {
    logger.info("Scheduler disabled (SCHEDULER_ENABLED=false)");
    return [];
  }
  const jobs: Array<[string, string, () => Promise<unknown>]> = [
    ["daily-summary", env.dailySummaryCron(), () => runDailySummary()],
    ["low-stock-check", env.lowStockCron(), () => runLowStockCheck()],
  ];
  // Validate everything before scheduling anything, so a bad expression leaves no timers running.
  for (const [name, expression] of jobs) {
    if (!cron.validate(expression)) throw new Error(`Invalid cron expression for ${name}: ${expression}`);
  }
  return jobs.map(([name, expression, run]) => {
    logger.info({ job: name, schedule: expression, timezone: LAGOS_TZ }, "Scheduled job");
    return cron.schedule(expression, async () => {
      try {
        logger.info({ job: name, result: await run() }, "Job completed");
      } catch (error) {
        logger.error({ err: error, job: name }, "Job failed");
      }
    }, { name, timezone: LAGOS_TZ, noOverlap: true });
  });
}
