import { z } from "zod";

export const loginSchema = z.object({
  phone: z.string().trim().min(7),
  password: z.string().min(6),
}).strict();

export const createRepSchema = z.object({
  name: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  vehicleReg: z.string().optional(),
  driverName: z.string().optional(),
  temporaryPassword: z.string().min(6).optional(),
  area: z.string().optional(),
}).strict();

export const productSchema = z.object({
  name: z.string().trim().min(2),
  unitPrice: z.number().int().positive(),
  lowStockThreshold: z.number().int().nonnegative().optional(),
}).strict();

export const customerSchema = z.object({
  clientId: z.string().uuid().optional(),
  name: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  address: z.string().trim().min(2),
}).strict();

export const orderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().positive().max(10000),
}).strict();

export const createOrderSchema = z.object({
  clientId: z.string().uuid(),
  customerId: z.string(),
  items: z.array(orderItemSchema).min(1),
  paymentMethod: z.enum(["cash", "transfer", "credit"]).default("cash"),
  note: z.string().max(500).optional(),
  placedAt: z.string().datetime().optional(),
  paperReceiptNo: z.string().optional(),
}).strict();

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateRepInput = z.infer<typeof createRepSchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type CustomerInput = z.infer<typeof customerSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
