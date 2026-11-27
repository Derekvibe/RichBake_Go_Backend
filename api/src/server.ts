import "./config/load-env";
import mongoose from "mongoose";
import { app } from "./app";
import { env, validateEnvironment } from "./config/env";
import { startScheduler } from "./jobs/scheduler";
import { logger } from "./utils/logger";

async function start() {
  validateEnvironment((message) => logger.warn(message));
  await mongoose.connect(env.mongoUri(), { serverSelectionTimeoutMS: 30000 });
  mongoose.connection.on("error", (error) => logger.error({ err: error }, "MongoDB connection error"));
  mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));

  const server = app.listen(env.port(), "0.0.0.0", () => logger.info({ port: env.port() }, "RichBake API listening"));
  const tasks = startScheduler();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    tasks.forEach((task) => task.stop());
    server.close(() => {
      mongoose.disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "Unhandled promise rejection"));

start().catch((error: unknown) => {
  if (error instanceof Error && error.name === "MongooseServerSelectionError") {
    logger.fatal("MongoDB Atlas connection failed. Verify MONGODB_URI, database credentials, cluster status, and the Atlas Network Access allowlist.");
  } else {
    logger.fatal({ err: error }, "Failed to start");
  }
  process.exit(1);
});
