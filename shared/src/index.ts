import { z } from "zod";

export const loginSchema = z.object({
  phone: z.string().min(7),
  password: z.string().min(6),
});

export const createRepSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(7),
  vehicleReg: z.string().optional(),
  driverName: z.string().optional(),
  temporaryPassword: z.string().min(6),
  area: z.string().optional(),
});

export const productSchema = z.object({
  name: z.string().min(2),
  unitPrice: z.number().int().nonnegative(),
});

export const customerSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(7),
  address: z.string().min(2),
});

export const orderItemSchema = z.object({
  productId: z.string(),
  qty: z.number().int().positive(),
});

export const createOrderSchema = z.object({
  clientId: z.string().min(8).max(100),
  customerId: z.string(),
  items: z.array(orderItemSchema).min(1),
  paymentMethod: z.enum(["cash", "transfer", "credit"]).default("cash"),
  placedAt: z.string().datetime().optional(),
  paperReceiptNo: z.string().optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateRepInput = z.infer<typeof createRepSchema>;
export type ProductInput = z.infer<typeof productSchema>;
export type CustomerInput = z.infer<typeof customerSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
