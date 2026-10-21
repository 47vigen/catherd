import { formatRelative } from "./time";

const now = new Date("2026-10-14T10:00:00Z");

test.each([
  ["2026-10-14T10:00:00Z", "just now"],
  ["2026-10-14T09:59:48Z", "12s ago"],
  ["2026-10-14T09:55:00Z", "5m ago"],
  ["2026-10-14T07:00:00Z", "3h ago"],
  ["2026-10-12T10:00:00Z", "2d ago"],
  ["2026-10-14T10:05:00Z", "in 5m"],
])("formatRelative(%s) = %s", (iso, want) => expect(formatRelative(iso, now)).toBe(want));

test("an unreadable time is shown as a dash", () => expect(formatRelative("nope", now)).toBe("–"));
