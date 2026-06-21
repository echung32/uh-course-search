/**
 * Classifies a Banner section attribute code into a display family and supplies
 * the shared color + label vocabulary used by the results-table badges and the
 * search filter menu. Unknown/future codes fall into "other" so nothing is hidden.
 */
export type AttributeFamily = "focus" | "foundations" | "diversification" | "other";

const FOCUS = new Set(["WI", "OC", "ETH", "HAP", "GAHP", "HOC", "HETH", "HHAP"]);
const FOUNDATIONS = new Set(["FW", "FS", "FGA", "FGB", "FGC"]);
const DIVERSIFICATION = new Set(["DA", "DB", "DH", "DL", "DP", "DS", "DY"]);

export function attributeFamily(code: string): AttributeFamily {
  if (FOCUS.has(code)) return "focus";
  if (FOUNDATIONS.has(code)) return "foundations";
  if (DIVERSIFICATION.has(code)) return "diversification";
  return "other";
}

export const FAMILY_ORDER: AttributeFamily[] = [
  "focus",
  "foundations",
  "diversification",
  "other",
];

export const FAMILY_LABEL: Record<AttributeFamily, string> = {
  focus: "Focus",
  foundations: "Foundations",
  diversification: "Diversification",
  other: "Other",
};

// One color family per group; legible in light + dark. Applied to shadcn Badge
// via className (variant="outline" supplies the base shape).
export const FAMILY_BADGE_CLASS: Record<AttributeFamily, string> = {
  focus:
    "border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800/60 dark:bg-amber-950 dark:text-amber-200",
  foundations:
    "border-sky-300 bg-sky-100 text-sky-900 dark:border-sky-800/60 dark:bg-sky-950 dark:text-sky-200",
  diversification:
    "border-violet-300 bg-violet-100 text-violet-900 dark:border-violet-800/60 dark:bg-violet-950 dark:text-violet-200",
  other:
    "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
};

/** Sort attributes grouped by family (Focus→Foundations→Diversification→Other), then code. */
export function sortAttributes<T extends { code: string }>(attrs: T[]): T[] {
  return [...attrs].sort((a, b) => {
    const fa = FAMILY_ORDER.indexOf(attributeFamily(a.code));
    const fb = FAMILY_ORDER.indexOf(attributeFamily(b.code));
    return fa - fb || a.code.localeCompare(b.code);
  });
}
