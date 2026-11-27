import { Router } from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { productSchema, statusSchema, updateProductSchema } from "@richbake/shared";
import { Product, RepStock } from "../models";
import { auth, requireRole } from "../middleware/auth.middleware";
import { env } from "../config/env";
import { envelope, listMeta, queryString, searchPattern, sendError, sendList, validateBody } from "../utils/http";
import { ApiError } from "../utils/transactions";

export const productsRouter = Router();
productsRouter.use(auth);

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const productUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (_req, file, callback) => {
    if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) return callback(null, true);
    callback(new ApiError(400, "INVALID_IMAGE", "Upload a JPEG, PNG or WebP image"));
  },
});

let cloudinaryReady = false;
function uploadImage(buffer: Buffer) {
  if (!cloudinaryReady) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    cloudinaryReady = true;
  }
  return new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "richbake/products", resource_type: "image", transformation: [{ width: 800, height: 800, crop: "limit" }, { quality: "auto" }] },
      (error, result) => (error || !result ? reject(error ?? new Error("Upload failed")) : resolve({ secure_url: result.secure_url, public_id: result.public_id })),
    );
    stream.end(buffer);
  });
}

/** Multipart fields arrive as strings; JSON bodies keep their types. */
const toNumber = (value: unknown) => (value === undefined || value === "" ? undefined : Number(value));

function productFields(body: Record<string, unknown>, partial: boolean) {
  const candidate = Object.fromEntries(Object.entries({
    name: body.name,
    unitPrice: toNumber(body.unitPrice),
    lowStockThreshold: toNumber(body.lowStockThreshold),
  }).filter(([, value]) => value !== undefined));
  return (partial ? updateProductSchema : productSchema).safeParse(candidate);
}

productsRouter.post("/", requireRole("admin"), productUpload.single("picture"), async (req, res) => {
  const parsed = productFields(req.body ?? {}, false);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid product details");
  if (await Product.exists({ name: parsed.data.name }).collation({ locale: "en", strength: 2 })) {
    return sendError(res, 409, "PRODUCT_EXISTS", "A product with this name already exists");
  }
  let image: { imageUrl?: string; imagePublicId?: string } = {};
  if (req.file) {
    if (!env.cloudinaryConfigured()) return sendError(res, 503, "IMAGE_UPLOAD_DISABLED", "Image uploads are not configured");
    const uploaded = await uploadImage(req.file.buffer);
    image = { imageUrl: uploaded.secure_url, imagePublicId: uploaded.public_id };
  }
  const product = await Product.create({ ...parsed.data, ...image });
  res.status(201).json(envelope(product));
});

productsRouter.get("/", async (req, res) => {
  const query: Record<string, unknown> = {};
  // Reps only ever see the active catalogue.
  if (req.auth!.role === "rep" || queryString(req.query.status) !== "all") query.isActive = true;
  const q = queryString(req.query.q);
  if (q) query.name = searchPattern(q);
  const meta = listMeta(req.query.page, req.query.limit, await Product.countDocuments(query));
  const products = await Product.find(query).sort({ name: 1 }).skip((meta.page - 1) * meta.limit).limit(meta.limit).lean();
  if (req.auth!.role !== "rep") return sendList(res, products, meta);
  const stock = await RepStock.find({ repId: req.auth!.id, productId: { $in: products.map((product) => product._id) } }).lean();
  const stockByProduct = new Map(stock.map((row) => [String(row.productId), row.quantity]));
  // Warehouse levels are internal; reps get their own stock instead.
  sendList(res, products.map(({ warehouseStock: _warehouse, imagePublicId: _publicId, ...product }) => ({ ...product, myStock: stockByProduct.get(String(product._id)) ?? 0 })), meta);
});

productsRouter.get("/:id", async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, ...(req.auth!.role === "rep" ? { isActive: true } : {}) }).lean();
  if (!product) return sendError(res, 404, "PRODUCT_NOT_FOUND", "Product not found");
  res.json(envelope(product));
});

// Stock levels change only through /stock/* so every change has a movement record.
productsRouter.patch("/:id", requireRole("admin"), productUpload.single("picture"), async (req, res) => {
  const unknownFields = Object.keys(req.body ?? {}).filter((key) => !["name", "unitPrice", "lowStockThreshold"].includes(key));
  if (unknownFields.length) return sendError(res, 400, "VALIDATION_ERROR", `Unsupported field: ${unknownFields[0]}`);
  const parsed = productFields(req.body ?? {}, true);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid product details");
  const update: Record<string, unknown> = { ...parsed.data };
  if (req.file) {
    if (!env.cloudinaryConfigured()) return sendError(res, 503, "IMAGE_UPLOAD_DISABLED", "Image uploads are not configured");
    const uploaded = await uploadImage(req.file.buffer);
    update.imageUrl = uploaded.secure_url;
    update.imagePublicId = uploaded.public_id;
  }
  const previous = await Product.findByIdAndUpdate(req.params.id, { $set: update }, { runValidators: true });
  if (!previous) return sendError(res, 404, "NOT_FOUND", "Product not found");
  if (req.file && previous.imagePublicId) void cloudinary.uploader.destroy(previous.imagePublicId).catch(() => undefined);
  res.json(envelope(await Product.findById(req.params.id).lean()));
});

productsRouter.patch("/:id/status", requireRole("admin"), validateBody(statusSchema), async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: req.body.isActive }, { new: true });
  if (!product) return sendError(res, 404, "NOT_FOUND", "Product not found");
  res.json(envelope(product));
});
