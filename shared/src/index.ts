import { z } from "zod";

/* ---------- Primitives ---------- */

export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

/** Password policy shared by self-service changes and admin-issued temporary passwords. */
export const passwordSchema = z
  .string()
  .min(8, "Password must have at least 8 characters")
  .max(128, "Password is too long")
  .regex(/[a-zA-Z]/, "Password must contain a letter")
  .regex(/[0-9]/, "Password must contain a number");

const phoneSchema = z.string().trim().min(7, "Enter a valid phone number").max(20, "Enter a valid phone number");
const optionalText = (max: number) => z.string().trim().max(max).optional();
const lagosDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD format");

/* ---------- Auth ---------- */

export const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1, "Password is required").max(128),
}).strict();

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
}).strict();

export const logoutSchema = z.object({
  pushToken: z.string().max(200).optional(),
  // Accepted for compatibility with older app builds; the session is always revoked server-side.
  refreshToken: z.string().nullable().optional(),
}).strict();

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required").max(128),
  newPassword: passwordSchema,
}).strict().refine((value) => value.currentPassword !== value.newPassword, {
  message: "New password must be different from the current password",
  path: ["newPassword"],
});

export const pushTokenSchema = z.object({
  token: z.string().regex(/^Expo(nent)?PushToken\[.+\]$/, "Invalid push token").max(200),
  platform: z.enum(["android", "ios"]),
}).strict();

export const removePushTokenSchema = z.object({
  token: z.string().min(1).max(200),
}).strict();

/* ---------- Users (sales reps) ---------- */

export const createRepSchema = z.object({
  name: z.string().trim().min(2, "Name must have at least 2 characters").max(100),
  phone: phoneSchema,
  vehicleReg: optionalText(30),
  driverName: optionalText(100),
  temporaryPassword: passwordSchema.optional(),
  area: optionalText(100),
}).strict();

export const updateRepSchema = createRepSchema.omit({ temporaryPassword: true }).partial();

export const statusSchema = z.object({
  isActive: z.boolean(),
}).strict();

export const resetPasswordSchema = z.object({
  temporaryPassword: passwordSchema,
}).strict();

/* ---------- Products ---------- */

export const productSchema = z.object({
  name: z.string().trim().min(2, "Name must have at least 2 characters").max(100),
  /** Price in kobo. */
  unitPrice: z.number().int().positive("Price must be greater than zero").max(100_000_000),
  lowStockThreshold: z.number().int().nonnegative().max(100_000).optional(),
}).strict();

export const updateProductSchema = productSchema.partial();

/* ---------- Stock ---------- */

const stockQuantity = z.number().int("Quantity must be a whole number").positive("Quantity must be at least 1").max(100_000);

const stockItemSchema = z.object({
  productId: objectIdSchema,
  quantity: stockQuantity,
}).strict();

/**
 * Stock endpoints accept either `items: [...]` or a single `productId` + `quantity`,
 * normalised to `items`.
 */
const stockItemsShape = {
  items: z.array(stockItemSchema).min(1).max(100).optional(),
  productId: objectIdSchema.optional(),
  quantity: stockQuantity.optional(),
  note: optionalText(500),
};

type StockItemsInput = {
  items?: { productId: string; quantity: number }[];
  productId?: string;
  quantity?: number;
};

function normaliseItems(value: StockItemsInput, context: z.RefinementCtx) {
  const items = value.items ?? (value.productId && value.quantity !== undefined ? [{ productId: value.productId, quantity: value.quantity }] : []);
  if (!items.length) context.addIssue({ code: "custom", message: "Choose a product and quantity", path: ["items"] });
  return items;
}

export const restockSchema = z.object(stockItemsShape).strict()
  .transform((value, context) => ({ note: value.note, items: normaliseItems(value, context) }));

const repStockMoveSchema = z.object({ ...stockItemsShape, repId: objectIdSchema }).strict()
  .transform((value, context) => ({ repId: value.repId, note: value.note, items: normaliseItems(value, context) }));

export const issueStockSchema = repStockMoveSchema;
export const returnStockSchema = repStockMoveSchema;

const adjustItemSchema = z.object({
  productId: objectIdSchema,
  quantity: z.number().int("Quantity must be a whole number").refine((value) => value !== 0, "Quantity cannot be zero").refine((value) => Math.abs(value) <= 100_000, "Quantity is too large"),
  repId: objectIdSchema.optional(),
}).strict();

export const adjustStockSchema = z.object({
  items: z.array(adjustItemSchema).min(1).max(100).optional(),
  productId: objectIdSchema.optional(),
  quantity: adjustItemSchema.shape.quantity.optional(),
  repId: objectIdSchema.optional(),
  reason: z.string().trim().min(1, "A reason is required").max(500),
}).strict().transform((value, context) => {
  const items = value.items ?? (value.productId && value.quantity !== undefined
    ? [{ productId: value.productId, quantity: value.quantity, repId: value.repId }]
    : []);
  if (!items.length) {
    context.addIssue({ code: "custom", message: "Choose a product and quantity", path: ["items"] });
    return z.NEVER;
  }
  return { reason: value.reason, items: items.map((item) => ({ ...item, repId: item.repId ?? value.repId })) };
});

/* ---------- Customers ---------- */

export const customerSchema = z.object({
  clientId: z.string().uuid().optional(),
  name: z.string().trim().min(2, "Name must have at least 2 characters").max(100),
  phone: phoneSchema,
  address: z.string().trim().min(2, "Address is required").max(300),
}).strict();

export const updateCustomerSchema = customerSchema.omit({ clientId: true }).partial();

/* ---------- Orders ---------- */

export const orderItemSchema = z.object({
  productId: objectIdSchema,
  quantity: z.number().int().positive().max(10000),
}).strict();

export const createOrderSchema = z.object({
  clientId: z.string().uuid(),
  customerId: objectIdSchema,
  items: z.array(orderItemSchema).min(1).max(100),
  paymentMethod: z.enum(["cash", "transfer", "credit"]).default("cash"),
  note: z.string().trim().max(500).optional(),
  placedAt: z.string().datetime().optional(),
  paperReceiptNo: z.string().regex(/^\d{1,9}$/, "Receipt number must contain digits only").optional(),
}).strict();

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(3, "Cancellation reason must be 3 to 200 characters").max(200, "Cancellation reason must be 3 to 200 characters"),
}).strict();

/* ---------- Receipt books ---------- */

export const createReceiptBookSchema = z.object({
  repId: objectIdSchema,
  startNo: z.number().int().positive(),
  endNo: z.number().int().positive(),
  prefix: z.string().trim().max(10).default(""),
}).strict()
  .refine((value) => value.endNo >= value.startNo, { message: "Enter a valid receipt number range", path: ["endNo"] })
  .refine((value) => value.endNo - value.startNo + 1 <= 1000, { message: "A receipt book cannot exceed 1000 numbers", path: ["endNo"] });

export const voidReceiptBookSchema = z.object({
  reason: z.string().trim().max(200).optional(),
}).strict();

/* ---------- Notifications ---------- */

export const NOTIFICATION_PREFERENCE_KEYS = [
  "orderCancelled", "stockIssued", "lowStock", "receiptBookLow", "dailySummary", "newOrder", "accountAlerts",
] as const;

export const notificationPreferencesSchema = z.object(
  Object.fromEntries(NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, z.boolean().optional()])) as Record<(typeof NOTIFICATION_PREFERENCE_KEYS)[number], z.ZodOptional<z.ZodBoolean>>,
).strict();

/* ---------- Jobs ---------- */

export const dailySummaryJobSchema = z.object({
  date: lagosDateSchema.optional(),
}).strict();

/* ---------- Types ---------- */

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateRepInput = z.infer<typeof createRepSchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type CustomerInput = z.infer<typeof customerSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type RestockInput = z.infer<typeof restockSchema>;
export type IssueStockInput = z.infer<typeof issueStockSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export type CreateReceiptBookInput = z.infer<typeof createReceiptBookSchema>;
