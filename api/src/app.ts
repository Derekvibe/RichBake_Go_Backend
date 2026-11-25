import express from "express";
import cors from "cors";
import helmet from "helmet";
import { apiRouter } from "./routes/api.routes";

export const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) =>
  res.json({ success: true, data: { status: "ok" }, error: null }),
);

app.use(apiRouter);

app.use((_req, res) =>
  res.status(404).json({
    success: false,
    data: null,
    error: { code: "NOT_FOUND", message: "Route not found" },
  }),
);
