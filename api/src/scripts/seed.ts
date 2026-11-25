import dotenv from "dotenv";
import path from "node:path";
dotenv.config({
  path: [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "backend/.env"),
    path.resolve(__dirname, "../../../.env"),
  ].find((candidate) => require("node:fs").existsSync(candidate)),
});
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { User } from "../models";

async function seed() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  if (!process.env.ADMIN_PHONE || !process.env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PHONE and ADMIN_PASSWORD are required");
  }
  const phone = process.env.ADMIN_PHONE;
  const password = process.env.ADMIN_PASSWORD;
  const existing = await User.findOne({ phone });
  if (!existing) {
    await User.create({
      role: "admin",
      name: "Administrator",
      phone,
      passwordHash: await bcrypt.hash(password, 12),
      isActive: true,
      mustChangePassword: false,
    });
    console.log(`Created admin ${phone}`);
  } else {
    console.log(`Admin ${phone} already exists`);
  }
  await mongoose.disconnect();
}

seed().catch((error) => {
  console.error(error);
  process.exit(1);
});
