import { afterEach, describe, expect, it } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { useEffect, useRef } from "react";
import { useApp } from "../../../src/entry/tui/providers/app.tsx";
import { useCommandLayer } from "../../../src/entry/tui/providers/keymap.tsx";
import { CatherdError } from "../../../src/domain/errors.ts";
import { errorToast, TOAST_MS } from "../../../src/entry/tui/providers/toast.tsx";
import { SPINNER } from "../../../src/entry/tui/theme.ts";
import { Footer, Header, Tabs } from "../../../src/entry/tui/widgets/chrome.tsx";
import { clip, Line } from "../../../src/entry/tui/widgets/line.tsx";
import { Spinner, useDelayedPresence } from "../../../src/entry/tui/widgets/spinner.tsx";
import { ToastHost } from "../../../src/entry/tui/widgets/toast.tsx";
import { type Harness, harness, PLAIN, UI } from "./harness.tsx";

let h: Harness | null = null;
afterEach(async () => {
  await h?.s.close();
  h = null;
});

describe("Line", () => {
  it("cuts parts at the end to the width", () => {
    expect(clip([{ text: "abc" }, { text: "defgh" }], 6, false)).toEqual([{ text: "abc" }, { text: "de…" }]);
    expect(clip([{ text: "abc" }, { text: "defgh" }], 6, true)).toEqual([{ text: "abc" }, { text: "..." }]);
  });

  it("fills exactly its width, and draws the selection in reverse video without colour", async () => {
    h = await harness(<Line width={12} selected parts={[{ text: "worker" }]} />, { width: 20, height: 1 });
    const row = h.s.captureSpans().lines[0];
    const text = row?.spans.map((s) => s.text).join("") ?? "";
    expect(text.slice(0, 12)).toBe("worker      ");
    expect(row?.spans[0]?.attributes && row.spans[0].attributes & TextAttributes.INVERSE).toBeTruthy();
  });
});

function LeaderHeader() {
  useCommandLayer("app", { "profile.new": () => {} });
  return <Header version="1.0.0" profile={null} active={false} dirty={0} mood="good" width={60} />;
}

describe("the chrome", () => {
  it("puts version, profile, unsaved count and face on one line", async () => {
    h = await harness(
      <Header version="1.0.0" profile="default" active dirty={2} mood="working" width={60} />,
      {
        width: 60,
        height: 1,
      },
    );
    expect(h.s.frame().split("\n")[0]).toBe(" catherd 1.0.0  profile default (active) · 2 unsaved  =o.o= ");
  });

  it("names a repo binding instead of active", async () => {
    h = await harness(
      <Header version="1.0.0" profile="cheap" active label="this repo" dirty={0} mood="good" width={60} />,
      { width: 60, height: 1 },
    );
    expect(h.s.frame().split("\n")[0]).toStartWith(" catherd 1.0.0  profile cheap (this repo)");
  });

  it("shows a pending ctrl+x leader in the header until the next key", async () => {
    h = await harness(<LeaderHeader />, {
      width: 60,
      height: 1,
    });
    await h.s.press("ctrl+x");
    expect(h.s.frame()).toContain("ctrl+x …");
    await h.s.press("escape");
    expect(h.s.frame()).not.toContain("ctrl+x");
  });

  it("marks the active tab", async () => {
    h = await harness(<Tabs tab="profiles" width={40} />, { width: 40, height: 1 });
    expect(h.s.frame()).toContain(" 1 Status   2 Profiles   3 Runs");
  });
});

function Hinted(props: { width: number }) {
  useCommandLayer("app", { "app.palette": () => {}, "app.help": () => {}, "app.quit": () => {} });
  useCommandLayer("tab.profiles", {
    "profile.save": () => {},
    "profile.activate": () => {},
    "edit.undo": () => {},
  });
  useCommandLayer("row.profiles", { "tree.toggle": () => {}, "tree.open": () => {} });
  return <Footer width={props.width} />;
}

describe("Footer (spec §9.2: hints are generated)", () => {
  it("lists the reachable hinted commands in order, key then label", async () => {
    h = await harness(<Hinted width={100} />, { width: 100, height: 1 });
    expect(h.s.frame().split("\n")[0]?.trimEnd()).toBe(
      " space toggle  enter change  ctrl+s save  a activate  ctrl+x u undo  ctrl+p commands  ? help",
    );
  });

  it("drops hints from the end to fit, but keeps the palette and help", async () => {
    h = await harness(<Hinted width={60} />, { width: 60, height: 1 });
    const line = h.s.frame().split("\n")[0] ?? "";
    expect(line.trimEnd()).toBe(" space toggle  enter change  ctrl+p commands  ? help");
  });
});

/** A select dialog's layer, as DialogSelect registers it, under the App's esc. */
function InDialog(props: { width: number }) {
  const app = useApp();
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    app.dispatch({
      type: "open",
      dialog: { kind: "select", purpose: { type: "palette" }, title: "x", empty: "", options: [] },
    });
  });
  useCommandLayer("global", { "app.back": () => {}, "app.interrupt": () => {} });
  useCommandLayer("dialog", {
    "dialog.up": () => {},
    "dialog.down": () => {},
    "dialog.submit": () => {},
  });
  return <Footer width={props.width} />;
}

describe("Footer in a dialog (P2)", () => {
  it("says how to move, choose and cancel", async () => {
    h = await harness(<InDialog width={80} />, { width: 80, height: 1 });
    expect(h.s.frame().split("\n")[0]?.trimEnd()).toBe(" ↑↓ move  enter choose  esc cancel");
  });

  it("does not offer esc as a hint outside a dialog", async () => {
    h = await harness(<Hinted width={100} />, { width: 100, height: 1 });
    expect(h.s.frame()).not.toContain("esc");
  });
});

function Presence(props: { active: boolean }) {
  const shown = useDelayedPresence(props.active);
  return <text>{shown ? "SHOWN" : "hidden"}</text>;
}

describe("motion (spec §9.3)", () => {
  it("shows a spinner only after 500 ms and keeps it at least 3 s", async () => {
    h = await harness(<Presence active />, { width: 20, height: 1 });
    await h.advance(SPINNER.showAfterMs - 2);
    expect(h.s.frame()).toContain("hidden");
    await h.advance(2);
    expect(h.s.frame()).toContain("SHOWN");
  });

  it("stands still under reduced motion and spins otherwise", async () => {
    h = await harness(<Spinner label="checking" />, { width: 20, height: 1 });
    expect(h.s.frame()).toContain("⋯ checking");
    await h.s.close();
    h = await harness(<Spinner label="checking" />, {
      width: 20,
      height: 1,
      ui: { ...UI, reducedMotion: false },
    });
    const first = h.s.frame();
    await h.advance(SPINNER.ms);
    expect(h.s.frame()).not.toBe(first);
    await h.s.close();
    h = await harness(<Spinner label="checking" />, { width: 20, height: 1, ui: PLAIN });
    expect(h.s.frame()).toContain("... checking");
  });
});

function Toaster() {
  const app = useApp();
  useEffect(() => {
    app.toast({ variant: "success", message: "Saved profile default" });
    app.toast({ variant: "info", message: "Catalog refreshed" });
  }, [app.toast]);
  return <ToastHost />;
}

describe("toasts", () => {
  it("shows one at a time at the top right with the queue's length, each for TOAST_MS", async () => {
    h = await harness(<Toaster />, { width: 60, height: 3 });
    expect(h.s.frame()).toContain("┃ Saved profile default  +1 more ┃");
    await h.advance(TOAST_MS);
    expect(h.s.frame()).toContain("┃ Catalog refreshed ┃");
    await h.advance(TOAST_MS);
    expect(h.s.frame()).not.toContain("┃");
  });
});

const FIX = "catherd profile use --repo --clear /home/someone/work/a-rather-long-client-name/services/api";

function FailToaster() {
  const app = useApp();
  useEffect(() => {
    app.toast(
      errorToast(
        new CatherdError("E_CONFIG_INVALID", "cannot delete cheap: a repo is bound to it", { fix: FIX }),
      ),
    );
  }, [app.toast]);
  useCommandLayer("tab.status", { "status.recheck": () => {} });
  return <ToastHost />;
}

describe("error toasts (spec §9.3: commands wrap)", () => {
  it("wraps the fix command in full on its own lines and keeps it until the next key", async () => {
    h = await harness(<FailToaster />, { width: 80, height: 8 });
    const text = () =>
      h!.s
        .frame()
        .split("\n")
        .map((l) => l.replace(/┃/g, "").trim())
        .join(" ");
    expect(text()).toContain("cannot delete cheap: a repo is bound to it");
    expect(text().replace(/\s+/g, "")).toContain(FIX.replace(/\s+/g, ""));
    for (const line of h.s.frame().split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(80);
    await h.advance(TOAST_MS * 10);
    expect(text().replace(/\s+/g, "")).toContain(FIX.replace(/\s+/g, ""));
    await h.s.press("r");
    expect(h.s.frame()).not.toContain("┃");
  });
});

describe("AppApi.keep", () => {
  it("drops a line it already holds, so exit prints each once", async () => {
    h = await harness(<text>x</text>, { width: 20, height: 1 });
    await h.run(() => {
      h?.app().keep(["agent a", "agent b"]);
      h?.app().keep(["agent b", "agent c"]);
      h?.app().exit(0);
    });
    expect(h.exits).toEqual([{ code: 0, kept: ["agent a", "agent b", "agent c"] }]);
  });
});
