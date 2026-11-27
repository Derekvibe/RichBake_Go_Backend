import { afterEach, describe, expect, test } from "@jest/globals";
import { startScheduler } from "./jobs/scheduler";

describe("job scheduler", () => {
  const original = { ...process.env };
  afterEach(() => { process.env = { ...original }; });

  test("schedules both jobs by default", () => {
    const tasks = startScheduler();
    try {
      expect(tasks).toHaveLength(2);
    } finally {
      tasks.forEach((task) => task.stop());
    }
  });

  test("can be switched off for extra instances", () => {
    process.env.SCHEDULER_ENABLED = "false";
    expect(startScheduler()).toHaveLength(0);
  });

  test("rejects an invalid cron expression at startup", () => {
    process.env.LOW_STOCK_CRON = "not a schedule";
    expect(() => startScheduler()).toThrow(/Invalid cron expression/);
  });
});
