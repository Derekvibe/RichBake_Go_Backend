/**
 * Central access to environment configuration. Values are read lazily so tests can set
 * `process.env` after modules are imported.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const flag = (name: string, fallback: boolean) => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
};

export const env = {
  isProduction: () => process.env.NODE_ENV === "production",
  isTest: () => process.env.NODE_ENV === "test",
  port: () => Number(process.env.PORT || process.env.API_PORT || 4000),
  mongoUri: () => required("MONGODB_URI"),
  jwtAccessSecret: () => required("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: () => required("JWT_REFRESH_SECRET"),
  cronSecret: () => process.env.CRON_SECRET || "",
  corsOrigins: () => process.env.CORS_ORIGIN?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [],
  trustProxy: () => process.env.TRUST_PROXY || "",
  cloudinaryConfigured: () => Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET),
  schedulerEnabled: () => flag("SCHEDULER_ENABLED", true),
  dailySummaryCron: () => process.env.DAILY_SUMMARY_CRON || "0 21 * * *",
  lowStockCron: () => process.env.LOW_STOCK_CRON || "0 7-20 * * *",
  business: () => ({
    name: process.env.BUSINESS_NAME || "RichBake",
    phone: process.env.BUSINESS_PHONE || "",
    address: process.env.BUSINESS_ADDRESS || "",
  }),
};

/** Fails fast at startup on missing secrets and warns about weak configuration. */
export function validateEnvironment(warn: (message: string) => void) {
  env.mongoUri();
  const access = env.jwtAccessSecret();
  const refresh = env.jwtRefreshSecret();
  if (access === refresh) warn("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET should be different values");
  if (access.length < 32 || refresh.length < 32) warn("JWT secrets should be at least 32 random characters");
  if (env.isProduction() && !env.trustProxy()) warn("TRUST_PROXY is not set; behind a hosting proxy all clients share one rate limit");
  if (!env.cronSecret()) warn("CRON_SECRET is not set; the /internal/jobs HTTP triggers are disabled (the built-in scheduler still runs)");
}
