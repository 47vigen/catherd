import { ownsPath } from "./changes.ts";

/** A path that holds tests: a test directory, a `.test`/`.spec` file, Go and Python test files. */
export const TEST_PATH =
  /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;

/** Test paths a lane changed that its Owns does not cover (plan 44 D11). */
export const guardedEdits = (changed: readonly string[], owns: readonly string[]): string[] =>
  changed.filter((p) => TEST_PATH.test(p) && !owns.some((o) => ownsPath(p, o)));
