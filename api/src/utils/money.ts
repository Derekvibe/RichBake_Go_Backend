/** Formats an amount in kobo as naira, e.g. 150000 -> "₦1,500.00". */
export function formatNaira(kobo: number) {
  return `₦${(kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
