const UNITS: [limit: number, size: number, suffix: string][] = [
  [60, 1, "s"],
  [3600, 60, "m"],
  [86400, 3600, "h"],
  [Number.POSITIVE_INFINITY, 86400, "d"],
];

/** A short relative time such as "12s ago", "3h ago" or "in 5m"; under a second is "just now". */
export function formatRelative(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "–";
  const seconds = Math.round((now.getTime() - t) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 1) return "just now";
  const [, size, suffix] = UNITS.find(([limit]) => abs < limit)!;
  const value = `${Math.floor(abs / size)}${suffix}`;
  return seconds > 0 ? `${value} ago` : `in ${value}`;
}
