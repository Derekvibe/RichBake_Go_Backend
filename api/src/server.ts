import dotenv from "dotenv";
import path from "node:path";
dotenv.config({
  path: [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "backend/.env"),
    path.resolve(__dirname, "../../.env"),
  ].find((candidate) => require("node:fs").existsSync(candidate)),
});
import mongoose from "mongoose";
import { app } from "./app";

const port = Number(process.env.API_PORT || 4000);

async function start() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 30000,
  });

  mongoose.connection.on("error", (error) => {
    console.error("MongoDB connection error", error);
  });

  app.listen(port, () => console.log(`RichBake API listening on ${port}`));
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
