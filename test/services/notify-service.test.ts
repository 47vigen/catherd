import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isCatherdError } from "../../src/domain/errors.ts";
import { panelOrigin, recordPanelOrigin, sendRunNotice } from "../../src/services/notify-service.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { configFile } from "../../src/services/profile-store.ts";
import { activate, createProfile, profileService } from "../../src/services/profile-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { fakeDeps, freshRun, testView } from "./helpers.ts";

afterEach(snapshotEnv());

function capture() {
  const posts: { url: string; body: string; title: string; headers: Record<string, string> }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    posts.push({
      url,
      headers: init.headers as Record<string, string>,
      body: String(init.body),
      title: (init.headers as Record<string, string>).Title as string,
    });
    return new Response("ok");
  }) as unknown as typeof globalThis.fetch;
  return { posts, fetch };
}

describe("sendRunNotice", () => {
  it("sends only the moments the profile's notify lists", async () => {
    const { run } = freshRun("wallet");
    const deps = fakeDeps({ view: testView({ notify: ["blocked", "finish"] }) });
    const { posts, fetch } = capture();
    expect(await sendRunNotice(deps, run, { unit: "M1", moment: "milestone" }, { fetch })).toBe(false);
    expect(await sendRunNotice(deps, run, { unit: "M1", moment: "blocked" }, { fetch })).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: "https://ntfy.sh/catherd-test" });
    expect(posts[0]?.body).toBe(`M1 needs your answer. — answer: catherd answer ${run.id} M1 "<answer>"`);
  });

  it("a parked question's notice uses its state", async () => {
    const { run } = freshRun("wallet");
    const deps = fakeDeps({ view: testView({ notify: ["blocked", "finish"] }) });
    const { posts, fetch } = capture();
    await appendEvent(run, {
      type: "question.parked",
      unit: "M1",
      reason: "land",
      question: "Resolve  this\nconflict",
    });
    expect(panelOrigin(deps)).toBeNull();
    await sendRunNotice(deps, run, { unit: "M1", moment: "blocked" }, { fetch });
    expect(posts[0]?.headers.Click).toBeUndefined();
    recordPanelOrigin(deps, "http://127.0.0.1:4317");
    expect(panelOrigin(fakeDeps())).toBe("http://127.0.0.1:4317");
    await sendRunNotice(deps, run, { unit: "M1", moment: "blocked" }, { fetch });
    expect(posts[1]?.body).toBe(`Resolve this conflict — answer: catherd answer ${run.id} M1 "<answer>"`);
    expect(posts[1]?.headers.Click).toBe("http://127.0.0.1:4317/questions");
    expect(posts[1]?.headers.Priority).toBe("4");
    expect(Buffer.from(posts[1]!.title.split("?")[3]!, "base64").toString()).toBe("catherd · land · wallet");
    recordPanelOrigin(deps, null);
    expect(panelOrigin(deps)).toBeNull();
    await appendEvent(run, { type: "run.ended", outcome: "cancelled", reportPath: null });
    await sendRunNotice(deps, run, { unit: "run", moment: "finish" }, { fetch });
    expect(posts[2]?.body).toContain("The run was cancelled:");
  });

  it("only clears the registration owned by those dependencies, even on a reused origin", () => {
    withHome();
    const older = fakeDeps();
    const newer = fakeDeps();
    const origin = "http://127.0.0.1:4317";
    recordPanelOrigin(older, origin);
    recordPanelOrigin(newer, origin);
    recordPanelOrigin(older, null);
    expect(panelOrigin(newer)).toBe(origin);
    recordPanelOrigin(fakeDeps(), null);
    expect(panelOrigin(newer)).toBe(origin);
    recordPanelOrigin(newer, null);
    expect(panelOrigin(newer)).toBeNull();
  });

  it("is false and quiet when the send fails", async () => {
    const { run } = freshRun("wallet");
    const deps = fakeDeps({ view: testView({ notify: ["finish"] }) });
    const fetch = (async () => new Response("no", { status: 500 })) as unknown as typeof globalThis.fetch;
    expect(await sendRunNotice(deps, run, { unit: "run", moment: "finish" }, { fetch })).toBe(false);
  });

  it("sends nothing from a test unless the test brings its own fetch", async () => {
    const { run } = freshRun("wallet");
    const deps = fakeDeps({ view: testView({ notify: ["finish"] }) });
    expect(process.env.CATHERD_NO_END_PUSH).toBe("1");
    expect(await sendRunNotice(deps, run, { unit: "run", moment: "finish" })).toBe(false);
  });
});

describe("the notify url", () => {
  const port = () => profileService(() => ({ host: "unknown", session: null, conflict: null }));

  it("creates one random ntfy.sh topic and keeps it", () => {
    withHome();
    const url = port().notifyUrl();
    expect(url).toMatch(/^https:\/\/ntfy\.sh\/catherd-[0-9a-f]{20}$/);
    expect(port().notifyUrl()).toBe(url);
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toMatchObject({ schema: 1, notify: { url } });
  });

  it("replaces it with an http(s) url, and refuses anything else", () => {
    withHome();
    port().setNotifyUrl("http://localhost:8080/mine");
    expect(port().notifyUrl()).toBe("http://localhost:8080/mine");
    for (const bad of ["ftp://x/y", "ntfy.sh/topic", ""]) {
      try {
        port().setNotifyUrl(bad);
        throw new Error("expected a refusal");
      } catch (e) {
        expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
      }
    }
    expect(port().notifyUrl()).toBe("http://localhost:8080/mine");
  });

  it("keeps what else the config holds", () => {
    withHome();
    createProfile("fast", undefined, "claude-code");
    activate("fast", null, "claude-code");
    port().notifyUrl();
    expect(JSON.parse(readFileSync(configFile(), "utf8"))).toMatchObject({ activeProfile: "fast" });
  });
});
