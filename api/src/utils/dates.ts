/** Business day boundaries for Africa/Lagos (WAT, UTC+1, no daylight saving). */
export const LAGOS_TZ = "Africa/Lagos";
export const DAY_MS = 24 * 60 * 60 * 1000;

export function lagosDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LAGOS_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return { year: Number(value("year")), month: Number(value("month")) - 1, day: Number(value("day")) };
}

/** `YYYY-MM-DD` of the given instant in Lagos. */
export function lagosDateString(date = new Date()) {
  const { year, month, day } = lagosDateParts(date);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Start of a `YYYY-MM-DD` calendar day in Lagos. */
export function lagosDayStart(date: string) {
  return new Date(`${date}T00:00:00.000+01:00`);
}

/** Lagos midnight at the start of the day containing `date`. */
export function lagosMidnightUtc(date = new Date()) {
  return lagosDayStart(lagosDateString(date));
}

export function lagosHour(date: Date) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: LAGOS_TZ, hour: "2-digit", hourCycle: "h23" }).format(date));
}

/** `YYMMDD` used in order and receipt numbers. */
export function lagosDateCode(date: Date) {
  return lagosDateString(date).replace(/-/g, "").slice(-6);
}

export type Period = "today" | "week" | "month" | "year" | "custom" | "all";

export function startOfLagosWeek(date = new Date()) {
  const today = lagosMidnightUtc(date);
  const { year, month, day } = lagosDateParts(date);
  const mondayOffset = (new Date(Date.UTC(year, month, day)).getUTCDay() + 6) % 7;
  return new Date(today.getTime() - mondayOffset * DAY_MS);
}

export function startOfLagosMonth(date = new Date()) {
  const { year, month } = lagosDateParts(date);
  return lagosDayStart(`${year}-${String(month + 1).padStart(2, "0")}-01`);
}

export function startOfLagosYear(date = new Date()) {
  return lagosDayStart(`${lagosDateParts(date).year}-01-01`);
}

const isDateString = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Resolves a reporting period to a half-open `[from, to)` range of Lagos days. */
export function lagosRange(periodValue: unknown, fromValue?: unknown, toValue?: unknown) {
  const period = (["today", "week", "month", "year", "custom", "all"].includes(String(periodValue)) ? String(periodValue) : "month") as Period;
  const today = lagosMidnightUtc();
  let from = today;
  let to = new Date(today.getTime() + DAY_MS);
  if (period === "week") from = startOfLagosWeek();
  else if (period === "month") from = startOfLagosMonth();
  else if (period === "year") from = startOfLagosYear();
  else if (period === "all") from = new Date(0);
  else if (period === "custom" && isDateString(fromValue) && isDateString(toValue)) {
    from = lagosDayStart(fromValue);
    to = new Date(lagosDayStart(toValue).getTime() + DAY_MS);
  }
  return { period, from, to };
}
