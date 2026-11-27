import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import mongoose from "mongoose";
import { env } from "./config/env";
import { apiRouter } from "./routes";
import { logger } from "./utils/logger";
import { mapError } from "./utils/transactions";

export const app = express();

// Behind a reverse proxy the socket address is the proxy's; this makes req.ip the real client,
// which the rate limiters key on. Set TRUST_PROXY to the number of proxy hops (usually 1).
const trustProxy = env.trustProxy();
if (trustProxy) {
  const hops = Number(trustProxy);
  app.set("trust proxy", Number.isInteger(hops) ? hops : trustProxy);
}

app.disable("x-powered-by");
app.use(helmet());
// The mobile app does not need CORS; browsers are only allowed from configured origins.
// Outside production, any origin is allowed to ease local web development.
const corsOrigins = env.corsOrigins();
app.use(cors({ origin: corsOrigins.length ? corsOrigins : !env.isProduction() }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) =>
  res.json({ success: true, data: { name: "RichBake API", status: "ok", health: "/health", api: "/api/v1" }, error: null }),
);

app.get("/health", (_req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({
    success: connected,
    data: { status: connected ? "ok" : "degraded", uptime: process.uptime(), db: connected ? "connected" : "disconnected" },
    error: null,
  });
});

app.use("/api/v1", apiRouter);

app.use((_req, res) =>
  res.status(404).json({ success: false, data: null, error: { code: "NOT_FOUND", message: "Route not found" } }),
);

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const result = mapError(error);
  if (result.status >= 500) logger.error({ err: error, method: req.method, path: req.path }, "Unhandled request error");
  if (res.headersSent) return;
  res.status(result.status).json(result.body);
});
