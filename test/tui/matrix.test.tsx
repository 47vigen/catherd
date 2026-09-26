import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { HarnessCost } from "../../src/core/harness.ts";
import { configDir } from "../../src/paths.ts";
import { defaultProfile } from "../../src/tui/profile-shim.ts";
import type { BackendStatus } from "../../src/tui/backends.ts";
import { Matrix } from "../../src/tui/matrix.tsx";
import type { Catalog, CatalogModel, Profile } from "../../src/types.ts";
import { withHome } from "../helpers.ts";
import { caps, catalogFixture, down, KEY, NOT_READY, PLAIN, press, READY, UI, widest } from "./helpers.ts";

interface HarnessProps {
  ui?: typeof UI;
  catalog?: Catalog;
  backends?: BackendStatus[];
  costs?: HarnessCost[];
  errors?: string[];
  reloadCatalog?: () => Catalog;
  onChange?: (p: Profile) => void;
  onSubmit?: () => void;
  onQuit?: () => void;
  onKey?: (k: string) => void;
}

function Harness(o: HarnessProps) {
  // start with no failover, so the picker tests see "none" (the default profile fails Codex over to Go)
  const [p, setP] = useState<Profile>(() => ({ ...defaultProfile(), failover: undefined }));
  const [c, setC] = useState(() => o.catalog ?? catalogFixture());
  return (
    <Matrix
      ui={o.ui ?? UI}
      profile={p}
      catalog={c}
      backends={o.backends ?? READY}
      costs={o.costs}
      errors={o.errors}
      reloadCatalog={o.reloadCatalog ?? (() => c)}
      onChange={(n) => {
        setP(n);
        o.onChange?.(n);
      }}
      onCatalog={setC}
      onSubmit={o.onSubmit ?? (() => {})}
      onQuit={o.onQuit ?? (() => {})}
      onKey={o.onKey}
    />
  );
}

// Left pane order: architect(0) verifier(1) worker(2) reviewer(3) ui-reviewer(4) artist(5) writer(6)
// researcher(7) objective(8) lock(9) harness:codex(10) harness:opencode(11) budget(12) failover(13)
// notify x3(14-16). Worker's detail, entered with →: backend:claude(0) model:claude-opus-5-5(1)
// backend:codex(2) model:gpt-6-sol(3) model:gpt-6-luna(4) backend:opencode(5) model:qwen3-coder(6).
const toWorker = down(2);
const intoWorkerDetail = [...toWorker, KEY.right];

async function mounted(el: ReactNode, width = 100, height = 40) {
  const setup = await testRender(el, { width, height });
  await setup.renderOnce();
  return setup;
}

describe("Matrix", () => {
  beforeEach(() => withHome());

  it("shows the left pane's roles and settings, and the selected role's detail on the right", async () => {
    const { captureCharFrame } = await mounted(<Harness />);
    const f = captureCharFrame();
    expect(f).toContain("ROLES");
    expect(f).toContain("architect");
    expect(f).toContain("ROUTING");
    expect(f).toContain("objective");
    expect(f).toContain("cost");
    expect(f).toContain("HARNESS");
    expect(f).toContain("BUDGET");
    expect(f).toContain("budget");
    expect(f).toContain("no cap");
    expect(f).toContain("FAILOVER");
    expect(f).toContain("failover");
    expect(f).toContain("none");
    expect(f).toContain("architect"); // selected action title in the right pane
  });

  it("shows a role's capable models and the climb ladder once selected", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness />);
    await press(mockInput, ...toWorker);
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("worker");
    expect(f).toContain("ladder");
    expect(f).toContain("luna high");
    expect(f).toContain("sol medium");
  });

  it("moves into the detail pane with → and shows models grouped by backend", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness />);
    await press(mockInput, ...intoWorkerDetail);
    await renderOnce();
    const f = captureCharFrame();
    for (const s of ["claude", "codex", "opencode", "gpt-6-sol", "gpt-6-luna", "qwen3-coder"])
      expect(f).toContain(s);
  });

  it("opens a model into its efforts with → and unticks one with space", async () => {
    const onChange = mock();
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness onChange={onChange} />);
    await press(mockInput, ...intoWorkerDetail, ...down(3), KEY.right);
    await renderOnce();
    expect(captureCharFrame()).toContain("medium high xhigh");
    await press(mockInput, KEY.down, KEY.down, KEY.space);
    await renderOnce();
    expect(onChange.mock.calls.at(-1)?.[0].roles.worker.models["gpt-6-sol"]).toEqual(["medium", "xhigh"]);
  });

  it("keeps the worker on", async () => {
    const onChange = mock();
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness onChange={onChange} />);
    await press(mockInput, ...toWorker, KEY.space);
    await renderOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(captureCharFrame()).toContain("The worker is always on.");
  });

  it("asks for a treat-like, writes the override, then ticks the unscored effort", async () => {
    const onChange = mock();
    const liked = { ...catalogFixture(), treatLike: { "gpt-6-luna#xhigh": "gpt-6-luna#high" } };
    const { captureCharFrame, mockInput, renderOnce } = await mounted(
      <Harness onChange={onChange} reloadCatalog={() => liked} />,
    );
    await press(mockInput, ...intoWorkerDetail, ...down(4), KEY.right, ...down(2), KEY.space);
    await renderOnce();
    expect(captureCharFrame()).toContain(
      "gpt-6-luna#xhigh has no scores yet. Treat it like which scored rung?",
    );
    await press(mockInput, KEY.enter);
    await renderOnce();
    const override = JSON.parse(readFileSync(join(configDir(), "catalog.override.json"), "utf8"));
    expect(override.treatLike["gpt-6-luna#xhigh"]).toBe("gpt-6-luna#high");
    expect(onChange.mock.calls.at(-1)?.[0].roles.worker.models["gpt-6-luna"]).toEqual(["high", "xhigh"]);
  });

  it("shows a failed treat-like save as a note, back on the matrix, without ticking", async () => {
    const onChange = mock();
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness onChange={onChange} />);
    await press(mockInput, ...intoWorkerDetail, ...down(4), KEY.right, ...down(2), KEY.space);
    await renderOnce();
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(join(configDir(), "catalog.override.json"), "{nope");
    await press(mockInput, KEY.enter);
    await new Promise((r) => setImmediate(r));
    await renderOnce();
    const frame = captureCharFrame();
    expect(frame).toContain("Could not save the treat-like:");
    expect(frame).not.toContain("Treat it like which scored rung?");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("greys out a backend that is not ready, shows its fix, and refuses to tick there", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness backends={NOT_READY} />);
    await press(mockInput, ...intoWorkerDetail);
    await renderOnce();
    expect(captureCharFrame()).toContain("not ready · npm i -g @openai/codex");
    // gpt-6-luna(4): high(5) is already ticked, xhigh(6) is not — space there hits the ready check.
    await press(mockInput, ...down(4), KEY.right, ...down(2), KEY.space);
    await renderOnce();
    expect(captureCharFrame()).toContain("codex is not ready yet.");
  });

  it("toggles a harness from the left pane, shows its mode and cost on the right", async () => {
    const onChange = mock();
    const costs: HarnessCost[] = [
      {
        backend: "codex",
        nativeRuns: 5,
        isolatedRuns: 3,
        nativeMedian: 40_000,
        isolatedMedian: 28_000,
        extraPerRun: 12_000,
      },
    ];
    const { captureCharFrame, mockInput, renderOnce } = await mounted(
      <Harness onChange={onChange} costs={costs} />,
    );
    await press(mockInput, ...down(10));
    await renderOnce();
    expect(captureCharFrame()).toContain("codex");
    expect(captureCharFrame()).toContain("native");
    expect(captureCharFrame()).toContain("customizations ~12k tokens/run");
    await press(mockInput, KEY.space);
    await renderOnce();
    expect(onChange.mock.calls.at(-1)?.[0].harness.codex.isolated).toBe(true);
    expect(captureCharFrame()).toContain("isolated");
  });

  it("has a text fallback for every glyph under --plain", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness ui={PLAIN} />);
    await press(mockInput, ...intoWorkerDetail);
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("worker");
    expect(f).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("filters the selected role's models with /", async () => {
    const onSubmit = mock();
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness onSubmit={onSubmit} />);
    await press(mockInput, ...toWorker, "/", "qwen", KEY.enter);
    await renderOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    const f = captureCharFrame();
    expect(f).toContain("qwen3-coder");
    expect(f).toContain("filter: qwen");
    expect(f).not.toContain("gpt-6-sol");
  });

  it("flips the objective and cycles the lock slots from the left pane", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness />);
    await press(mockInput, ...down(8), KEY.space, KEY.down, KEY.space);
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("speed");
    expect(f).toContain("1");
  });

  it("sets a budget cap and clears it again", async () => {
    const onChange = mock();
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness onChange={onChange} />);
    await press(mockInput, ...down(12), KEY.space, KEY.space, "3", "0", KEY.enter);
    await renderOnce();
    expect(onChange.mock.calls.at(-1)?.[0].budget).toEqual({ minutes: 30 });
    expect(captureCharFrame()).toContain("30 min");
    await press(mockInput, KEY.space, KEY.backspace, KEY.backspace, KEY.enter);
    await renderOnce();
    expect(onChange.mock.calls.at(-1)?.[0].budget).toBeUndefined();
  });

  it("picks a failover stand-in on another backend, and can clear it back to none", async () => {
    const onChange = mock();
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness onChange={onChange} />);
    await press(mockInput, ...down(13), KEY.space, KEY.space);
    await renderOnce();
    expect(captureCharFrame()).toContain("Stand-in for gpt-6-luna#high on a quota limit:");
    expect(captureCharFrame()).not.toContain("gpt-6-sol#high");
    await press(mockInput, KEY.down, KEY.enter);
    await renderOnce();
    expect(onChange.mock.calls.at(-1)?.[0].failover).toEqual({
      "gpt-6-luna#high": "claude-opus-5-5#high",
    });
    await press(mockInput, KEY.space, KEY.enter);
    await renderOnce();
    expect(onChange.mock.calls.at(-1)?.[0].failover).toBeUndefined();
  });

  it("hands Enter, q and other letters to the parent", async () => {
    const onSubmit = mock();
    const onQuit = mock();
    const onKey = mock();
    const { mockInput } = await mounted(<Harness onSubmit={onSubmit} onQuit={onQuit} onKey={onKey} />);
    await press(mockInput, KEY.enter, "q", "z");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith("z");
  });

  it("cuts a very long model id at 80 columns", async () => {
    const long: CatalogModel = {
      id: `openrouter/${"a-very-long-vendor-name/".repeat(5)}model`,
      backend: "opencode",
      efforts: ["high"],
      capabilities: caps(),
    };
    const { captureCharFrame, mockInput, renderOnce } = await mounted(
      <Harness catalog={catalogFixture([long])} />,
      80,
    );
    await press(mockInput, ...intoWorkerDetail);
    await renderOnce();
    const f = captureCharFrame();
    expect(widest(f)).toBeLessThanOrEqual(80);
  });

  it("shows inline validation errors in the right pane", async () => {
    const { captureCharFrame } = await mounted(<Harness errors={["worker: no usable model is enabled"]} />);
    expect(captureCharFrame()).toContain("worker: no usable model is enabled");
  });
});
