import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authRouter } from "./auth.routes";
import { customersRouter } from "./customers.routes";
import { jobsRouter } from "./jobs.routes";
import { notificationsRouter } from "./notifications.routes";
import { ordersRouter } from "./orders.routes";
import { productsRouter } from "./products.routes";
import { receiptBooksRouter } from "./receipt-books.routes";
import { reportsRouter } from "./reports.routes";
import { stockRouter } from "./stock.routes";
import { usersRouter } from "./users.routes";

/** Version 1 of the API, mounted at /api/v1. */
export const apiRouter = Router();

apiRouter.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." } },
}));

apiRouter.use("/auth", authRouter);
apiRouter.use("/users", usersRouter);
apiRouter.use("/products", productsRouter);
apiRouter.use("/stock", stockRouter);
apiRouter.use("/customers", customersRouter);
apiRouter.use("/orders", ordersRouter);
apiRouter.use("/receipt-books", receiptBooksRouter);
apiRouter.use("/notifications", notificationsRouter);
apiRouter.use("/reports", reportsRouter);
apiRouter.use("/internal/jobs", jobsRouter);
