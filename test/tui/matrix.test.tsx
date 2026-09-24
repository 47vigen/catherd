import { readFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { HarnessCost } from "../../src/core/harness.ts";
import { configDir } from "../../src/paths.ts";
import { defaultProfile } from "../../src/profile/profile.ts";
import type { BackendStatus } from "../../src/tui/backends.ts";
import { Matrix } from "../../src/tui/matrix.tsx";
import { Screen } from "../../src/tui/ui.tsx";
import type { Catalog, CatalogModel, Profile } from "../../src/types.ts";
import { withHome } from "../helpers.ts";
import { caps, catalogFixture, down, KEY, NOT_READY, PLAIN, press, READY, UI, widest } from "./helpers.ts";

interface HarnessProps {
  ui?: typeof UI;
  catalog?: Catalog;
  backends?: BackendStatus[];
  costs?: HarnessCost[];
  reloadCatalog?: () => Catalog;
  onChange?: (p: Profile) => void;
  onSubmit?: () => void;
  onQuit?: () => void;
  onKey?: (k: string) => void;
}

function Harness(o: HarnessProps) {
  const [p, setP] = useState(defaultProfile);
  const [c, setC] = useState(() => o.catalog ?? catalogFixture());
  return (
    <Screen>
      <Matrix
        ui={o.ui ?? UI}
        profile={p}
        catalog={c}
        backends={o.backends ?? READY}
        costs={o.costs}
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
    </Screen>
  );
}

// Worker open: 2 worker, 3 claude, 4 claude-opus-5-5, 5 codex, 6 codex harness, 7 gpt-6-sol, 8 gpt-6-luna,
// 9 opencode, 10 opencode harness, 11 qwen3-coder. Luna open adds 9 high, 10 xhigh, 11 max.
const openWorker = [...down(2), KEY.right];

async function mounted(el: ReactNode, width = 100, height = 24) {
  const setup = await testRender(el, { width, height });
  await setup.renderOnce();
  return setup;
}

describe("Matrix", () => {
  beforeEach(() => withHome());

  it("shows one row per role with what is ticked, and the settings below", async () => {
    const { captureCharFrame } = await mounted(<Harness />);
    const f = captureCharFrame();
    expect(f).toContain("worker      luna#high, sol#medium, sol#high, sol#xhigh");
    expect(f).toContain("objective     cost");
    expect(f).toContain("🐾 notify on milestone");
  });

  it("opens the worker into backends, harness toggles and models, then a model into its efforts", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness />);
    await press(mockInput, ...openWorker, ...down(6), KEY.right);
    await renderOnce();
    const f = captureCharFrame();
    for (const s of ["claude", "codex: [native] ⇄ isolated", "gpt-6-sol", "opencode", "qwen3-coder"])
      expect(f).toContain(s);
    expect(f).toContain("🐾 high");
    expect(f).toContain("xhigh unscored");
  });

  it("keeps the worker on", async () => {
    const onChange = mock();
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness onChange={onChange} />);
    await press(mockInput, ...down(2), KEY.space);
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
    await press(mockInput, ...openWorker, ...down(6), KEY.right, ...down(2), KEY.space);
    await renderOnce();
    expect(captureCharFrame()).toContain(
      "gpt-6-luna#xhigh has no scores yet. Treat it like which scored rung?",
    );
    await press(mockInput, KEY.enter);
    await renderOnce();
    const override = JSON.parse(readFileSync(join(configDir(), "catalog.override.json"), "utf8"));
    expect(override.treatLike["gpt-6-luna#xhigh"]).toBe("gpt-6-luna#high");
    expect(onChange.mock.calls.at(-1)?.[0].roles.worker.models["gpt-6-luna"]).toEqual(["high", "xhigh"]);
    expect(captureCharFrame()).toContain("xhigh like luna#high");
  });

  it("greys out a backend that is not ready, shows its fix, and refuses to tick there", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness backends={NOT_READY} />);
    await press(mockInput, ...openWorker);
    await renderOnce();
    expect(captureCharFrame()).toContain("codex not ready · npm i -g @openai/codex");
    await press(mockInput, ...down(6), KEY.right, ...down(2), KEY.space);
    await renderOnce();
    expect(captureCharFrame()).toContain("codex is not ready yet.");
  });

  it("toggles a harness, shows its hint on the cursor and the cost beside it", async () => {
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
    await press(mockInput, ...openWorker, ...down(4));
    await renderOnce();
    expect(captureCharFrame()).toContain("codex: [native] ⇄ isolated customizations ~12k tokens/run");
    expect(captureCharFrame()).toContain(
      "native keeps your Codex config, hooks, skills, AGENTS.md; isolated saves tokens",
    );
    await press(mockInput, KEY.space);
    await renderOnce();
    expect(onChange.mock.calls.at(-1)?.[0].harness.codex.isolated).toBe(true);
    expect(captureCharFrame()).toContain("codex: native ⇄ [isolated]");
  });

  it("has a text fallback for every glyph under --plain", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness ui={PLAIN} />);
    await press(mockInput, ...openWorker);
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("codex: [native] <-> isolated");
    expect(f).toContain("v [x] worker");
    expect(f).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("filters models with / and keeps the filter on Enter without submitting", async () => {
    const onSubmit = mock();
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness onSubmit={onSubmit} />);
    await press(mockInput, "/", "qwen", KEY.enter);
    await renderOnce();
    expect(onSubmit).not.toHaveBeenCalled();
    const f = captureCharFrame();
    expect(f).toContain("qwen3-coder");
    expect(f).toContain("filter: qwen");
    expect(f).not.toContain("gpt-6-sol");
  });

  it("flips the objective and cycles the lock slots", async () => {
    const { captureCharFrame, mockInput, renderOnce } = await mounted(<Harness />);
    await press(mockInput, ...down(8), KEY.space, KEY.down, KEY.space);
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("objective     speed");
    expect(f).toContain("heavy slots   1");
  });

  it("hands Enter, q and other letters to the parent", async () => {
    const onSubmit = mock();
    const onQuit = mock();
    const onKey = mock();
    const { mockInput } = await mounted(<Harness onSubmit={onSubmit} onQuit={onQuit} onKey={onKey} />);
    await press(mockInput, KEY.enter, "q", "p");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith("p");
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
    );
    await press(mockInput, ...openWorker);
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("a-very-long-vendor-name");
    expect(widest(f)).toBeLessThanOrEqual(80);
  });

  it("shows a window around the cursor when a role has hundreds of models", async () => {
    const many = Array.from({ length: 200 }, (_, i): CatalogModel => ({
      id: `openrouter/v/m${i}`,
      backend: "opencode",
      efforts: ["high"],
      capabilities: caps(),
    }));
    const { captureCharFrame, mockInput, renderOnce } = await mounted(
      <Harness catalog={catalogFixture(many)} />,
      100,
      30,
    );
    await press(mockInput, ...openWorker, ...down(60));
    await renderOnce();
    const f = captureCharFrame();
    expect(f).toContain("❯");
    expect(f).toContain("m49");
    expect(f.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(17);
  });
});
