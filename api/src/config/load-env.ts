import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Loads the first `.env` found for the usual working directories (repo root, backend/, or the
 * compiled dist folder). Platform environment variables always take precedence.
 */
const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "backend/.env"),
  path.resolve(__dirname, "../../../.env"),
  path.resolve(__dirname, "../../.env"),
];
const envFile = candidates.find((candidate) => fs.existsSync(candidate));
if (envFile) dotenv.config({ path: envFile, quiet: true });
