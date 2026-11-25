import express from "express";
import cors from "cors";
import helmet from "helmet";
import { apiRouter } from "./routes/api.routes";

export const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || true }));
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) =>
  res.json({
    success: true,
    data: {
      name: "RichBake API",
      status: "ok",
      health: "/health",
      api: "/api/v1",
    },
    error: null,
  }),
);

app.get("/health", (_req, res) =>
  res.json({
    success: true,
    data: {
      status: "ok",
      uptime: process.uptime(),
      db: "connected",
      version: process.env.npm_package_version || "1.0.0",
    },
  }),
);

app.use(apiRouter);

app.use((_req, res) =>
  res.status(404).json({
    success: false,
    data: null,
    error: { code: "NOT_FOUND", message: "Route not found" },
  }),
);
