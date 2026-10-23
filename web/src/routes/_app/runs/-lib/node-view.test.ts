import type { RunNode } from "../../../../client";
import { CASE_HELPERS } from "./case-helpers.fixture";
import {
  formatDuration,
  KIND_ICON,
  modelName,
  nodeSecs,
  nodeView,
  nowLine,
  parseRung,
  roundsOf,
  shortTitle,
  STATUS_TONE,
  toneOf,
} from "./node-view";

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

test("a model id reads the way people say it", () => {
  expect(modelName("claude-opus-5-5")).toBe("Claude Opus 5.5");
  expect(modelName("gpt-6-luna")).toBe("GPT-6 Luna");
  expect(modelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
  expect(modelName("kimi-k2")).toBe("Kimi K2");
});

test("a step in a milestone drops the milestone from its title; a bare status says nothing more", () => {
  const review = CASE_HELPERS.nodes.find((n) => n.id === "M1/review")!;
  expect(shortTitle(review)).toBe("Review");
  expect(shortTitle(CASE_HELPERS.nodes.find((n) => n.kind === "lane")!)).toBe("M1.L1 worker");
  expect(nowLine(node({ status: "done", now: "Done" }))).toBeNull();
  expect(nowLine(node({ status: "running", now: "Codex is writing" }))).toBe("Codex is writing");
});

test("a set of steps takes its most urgent tone", () => {
  expect(toneOf([node({ status: "done" }), node({ status: "running" })])).toBe("running");
  expect(toneOf([node({ status: "parked" }), node({ status: "running" })])).toBe("warning");
  expect(toneOf([node({ status: "done" }), node({ status: "skipped" })])).toBe("success");
  expect(toneOf([node({ status: "done" }), node({ status: "pending" })])).toBe("muted");
});
