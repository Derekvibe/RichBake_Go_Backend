import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { User } from "../models";

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/richbake");
  const phone = process.env.ADMIN_PHONE || "08000000000";
  const password = process.env.ADMIN_PASSWORD || "Admin123!";
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
