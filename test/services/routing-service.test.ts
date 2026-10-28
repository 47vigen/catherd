import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { writeIndexFile } from "../../src/infra/slopalytics.ts";
import { indexPath } from "../../src/infra/paths.ts";
import { routingService } from "../../src/services/routing-service.ts";
import { indexOf } from "../domain/shipped.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { testView } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => {
  withHome();
  // claude-code lists models through Anthropic's API when this is set
  delete process.env.ANTHROPIC_API_KEY;
  // no backend CLI answers a listing here: discovery stays empty
  process.env.PATH = "/nonexistent";
});

const readJsonIndex = () => JSON.parse(readFileSync(indexPath(), "utf8"));

describe("checkStart (the routing port after plan 49: the ladders pick, nothing decides)", () => {
  it("names the roles the index cannot fill, and returns the index it read", async () => {
    const view = testView();
    const ok = await routingService().checkStart(view, "/nowhere");
    expect(ok.unusable).toEqual([]);
    expect(ok.index?.models.length).toBeGreaterThan(0);
    writeIndexFile(indexPath(), indexOf({ "gpt-6-luna#high": 33 }));
    const lost = await routingService().checkStart(view, "/nowhere");
    // Luna high is the writer's rung; the worker keeps Luna high, the reviewer's Sol high is gone
    expect(lost.unusable).toEqual(["architect", "reviewer"]);
    expect(lost.causes).toEqual({ architect: "index", reviewer: "index" });
    expect(lost.index).toEqual(indexOf({ "gpt-6-luna#high": 33 }));
  });

  it("leaves the index file as it was when it is fresh and under CATHERD_NO_SYNC=1", async () => {
    process.env.CATHERD_NO_SYNC = "1";
    const before = JSON.stringify(readJsonIndex());
    await routingService().checkStart(testView(), "/nowhere");
    expect(JSON.stringify(readJsonIndex())).toBe(before);
  });
});
