export const PAGE_SIZES = [25, 50, 100] as const;

export type PageSize = (typeof PAGE_SIZES)[number];
export type ListSearch = { page: number; pageSize: PageSize; q: string };

function toInt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) ? n : undefined;
}

/** Reads the shared list parameters from a route's raw search, falling back to page 1, 25 rows and no query. */
export function parseListSearch(raw: Record<string, unknown>): ListSearch {
  const page = toInt(raw.page);
  const size = toInt(raw.pageSize);
  return {
    page: page !== undefined && page >= 1 ? page : 1,
    pageSize: PAGE_SIZES.find((s) => s === size) ?? 25,
    q: typeof raw.q === "string" ? raw.q.trim() : "",
  };
}

/** Returns `v` when it is one of `allowed`, otherwise undefined. */
export function parseEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return allowed.find((a) => a === v);
}

/** The number of pages for `total` rows; at least 1, so an empty list still shows page 1. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
