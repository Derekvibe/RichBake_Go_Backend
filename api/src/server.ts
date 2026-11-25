import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
import mongoose from "mongoose";
import { app } from "./app";

const port = Number(process.env.API_PORT || 4000);

async function start() {
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/richbake";
  await mongoose.connect(uri);
  app.listen(port, () => console.log(`RichBake API listening on ${port}`));
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
