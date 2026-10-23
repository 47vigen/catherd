import type { RunNode } from "../../../../client";
import { CASE_HELPERS } from "./case-helpers.fixture";
import { formatDuration, KIND_ICON, nodeSecs, nodeView, parseRung, roundsOf, STATUS_TONE } from "./node-view";

const KINDS = Object.keys(KIND_ICON) as RunNode["kind"][];
const STATUSES = Object.keys(STATUS_TONE) as RunNode["status"][];
const node = (over: Partial<RunNode> = {}): RunNode => ({ ...CASE_HELPERS.nodes[0]!, ...over });

test("every kind has an icon and every status a tone", () => {
  expect(KINDS).toHaveLength(15);
  expect(STATUSES).toHaveLength(7);
  for (const kind of KINDS)
    for (const status of STATUSES) {
      const v = nodeView(node({ kind, status }));
      expect(v.icon, `${kind}/${status}`).toBeTruthy();
      expect(v.tone, `${kind}/${status}`).toBeTruthy();
    }
});

test("a lane with two rounds says round 2; one round says nothing", () => {
  const lane = CASE_HELPERS.nodes.find((n) => n.kind === "lane")!;
  expect(roundsOf(lane)).toBe(2);
  expect(nodeView(lane).badge).toBe("round 2");
  expect(nodeView(CASE_HELPERS.nodes.find((n) => n.kind === "verify")!).badge).toBeNull();
});

test("a parked step shows a question badge, a pending one is muted", () => {
  expect(nodeView(node({ status: "parked" })).badge).toBe("Question");
  expect(nodeView(node({ status: "pending" })).muted).toBe(true);
  expect(nodeView(node({ status: "running" })).muted).toBe(false);
});

test("a rung splits into backend, model and effort", () => {
  expect(parseRung("codex:gpt-6-luna#high")).toEqual({ backend: "codex", model: "gpt-6-luna", effort: "high" });
  expect(parseRung("claude")).toEqual({ backend: "claude", model: "", effort: null });
});

test("durations read short, and a running step counts to now", () => {
  expect(formatDuration(46)).toBe("46s");
  expect(formatDuration(125)).toBe("2m 05s");
  expect(formatDuration(3780)).toBe("1h 03m");
  const running = node({ status: "running", startedAt: "2026-10-22T10:00:00Z", endedAt: null });
  expect(nodeSecs(running, Date.parse("2026-10-22T10:01:30Z"))).toBe(90);
  expect(nodeSecs(node({ startedAt: null }), 0)).toBeNull();
});
