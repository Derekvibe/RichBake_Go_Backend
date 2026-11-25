import mongoose, { Schema } from "mongoose";

const timestamps = { timestamps: true };

export const User = mongoose.model("User", new Schema({
  role: { type: String, enum: ["admin", "rep"], required: true },
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  vehicleReg: String,
  driverName: String,
  repCode: { type: String, unique: true, sparse: true },
  area: String,
  isActive: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: true },
  pushTokens: { type: [String], default: [] },
  refreshTokenHash: String,
  notificationPrefs: { type: Map, of: Boolean, default: {} },
}, timestamps));

export const Product = mongoose.model("Product", new Schema({
  name: { type: String, required: true },
  unitPrice: { type: Number, required: true, min: 0 },
  imageUrl: String,
  imagePublicId: String,
  warehouseStock: { type: Number, default: 0, min: 0 },
  lowStockThreshold: { type: Number, default: 10, min: 0 },
  isActive: { type: Boolean, default: true },
}, timestamps));

export const RepStock = mongoose.model("RepStock", new Schema({
  repId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  quantity: { type: Number, required: true, min: 0 },
}, timestamps));
RepStock.schema.index({ repId: 1, productId: 1 }, { unique: true });

export const Customer = mongoose.model("Customer", new Schema({
  repId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  address: { type: String, required: true },
  orderCount: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  lastOrderAt: Date,
}, timestamps));
Customer.schema.index({ repId: 1, phone: 1 }, { unique: true });

export const Order = mongoose.model("Order", new Schema({
  orderNo: { type: String, required: true, unique: true },
  clientId: { type: String, required: true, unique: true },
  repId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
  items: [{
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: { type: String, required: true },
    unitPrice: { type: Number, required: true },
    qty: { type: Number, required: true },
    lineTotal: { type: Number, required: true },
  }],
  total: { type: Number, required: true },
  paymentMethod: { type: String, enum: ["cash", "transfer", "credit"], default: "cash" },
  status: { type: String, enum: ["COMPLETED", "CANCELLED"], default: "COMPLETED" },
  placedAt: { type: Date, required: true },
  placedHourLagos: { type: Number, required: true, min: 0, max: 23 },
  cancelledAt: Date,
  cancelReason: String,
  cancelledBy: Schema.Types.ObjectId,
  receiptNo: { type: String, unique: true, required: true },
}, timestamps));

export const StockMovement = mongoose.model("StockMovement", new Schema({
  type: { type: String, enum: ["RESTOCK", "ISSUE_TO_REP", "SALE", "CANCEL_RETURN", "RETURN_TO_WAREHOUSE", "ADJUSTMENT"], required: true },
  productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  repId: { type: Schema.Types.ObjectId, ref: "User" },
  quantity: { type: Number, required: true },
  orderId: { type: Schema.Types.ObjectId, ref: "Order" },
  performedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  note: String,
}, timestamps));

export const ReceiptBook = mongoose.model("ReceiptBook", new Schema({
  repId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  startNo: { type: Number, required: true },
  endNo: { type: Number, required: true },
  nextNo: { type: Number, required: true },
  status: { type: String, enum: ["ACTIVE", "FULL", "VOIDED"], default: "ACTIVE" },
  assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  assignedAt: { type: Date, default: Date.now },
  voidReason: String,
}, timestamps));
ReceiptBook.schema.index({ repId: 1, status: 1 });

export const Notification = mongoose.model("Notification", new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  body: { type: String, required: true },
  linkType: String,
  linkId: String,
  readAt: Date,
}, timestamps));
