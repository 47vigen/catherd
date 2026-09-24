import { TextAttributes } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { useRef, useState } from "react";
import { type HarnessCost, harnessCosts } from "../core/harness.ts";
import { listRuns } from "../core/runstore.ts";
import { defaultProfile, validateProfile } from "../profile/profile.ts";
import { loadCatalog } from "../routing/catalog.ts";
import { jevKey, saveJevKey, testJevKey } from "../routing/jev.ts";
import type { Catalog, Profile } from "../types.ts";
import { type BackendStatus, detectBackends } from "./backends.ts";
import { matrixHint, Matrix } from "./matrix.tsx";
import { saveAndActivate } from "./profiles.ts";
import { dot, glyph, tint, type Ui } from "./theme.ts";
import { CatSpinner, Frame, Intro } from "./ui.tsx";

export interface InitDeps {
  jevKey: () => string | null;
  testJevKey: (key: string) => Promise<boolean>;
  saveJevKey: (key: string) => void;
  detectBackends: () => Promise<BackendStatus[]>;
  loadCatalog: () => Catalog;
  harnessCosts: () => HarnessCost[];
  save: (p: Profile, c: Catalog) => void;
}

const initDeps: InitDeps = {
  jevKey,
  testJevKey,
  saveJevKey,
  detectBackends,
  loadCatalog,
  harnessCosts: () => harnessCosts(listRuns().map((r) => r.dir)),
  save: saveAndActivate,
};

export const PLUGIN_STEPS = ["/plugin marketplace add 47vigen/catherd", "/plugin install catherd@catherd"];

type Phase = "intro" | "key" | "testing" | "backends" | "matrix" | "done";

function title(phase: Phase, plain: boolean): string {
  const dotSep = glyph("dot", plain);
  return {
    intro: "",
    key: `Setup 1/3 ${dotSep} Jev key`,
    testing: `Setup 1/3 ${dotSep} Jev key`,
    backends: `Setup 2/3 ${dotSep} Backends`,
    matrix: `Setup 3/3 ${dotSep} Your profile`,
    done: `Setup ${dotSep} ready`,
  }[phase];
}

function BackendLine({ ui, b }: { ui: Ui; b: BackendStatus }) {
  const ok = b.installed && b.loggedIn;
  const state = !b.installed ? "not installed" : b.loggedIn ? "logged in" : "not logged in";
  const fix = b.fix ? ` ${glyph("dot", ui.plain)} fix: ${b.fix}` : "";
  return (
    <text wrapMode="none" truncate attributes={ok ? TextAttributes.NONE : TextAttributes.DIM}>
      {`${dot(ok ? "ready" : "missing", ui.plain)} ${b.backend.padEnd(9)}${(b.version ?? "").padEnd(9)}${state}${fix}`}
    </text>
  );
}

/** No masked input ships with OpenTUI, so the key is kept in state and shown as asterisks. */
function MaskedKeyInput({ onSubmit }: { onSubmit: (key: string) => void }) {
  const [value, setValue] = useState("");
  useKeyboard((key) => {
    if (key.name === "return") {
      onSubmit(value);
      return;
    }
    if (key.name === "backspace") {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta) {
      const ch = key.name === "space" ? " " : key.sequence;
      if (ch && ch.length === 1) setValue((v) => v + ch);
    }
  });
  usePaste((e) => setValue((v) => v + new TextDecoder().decode(e.bytes).replace(/\s+/g, "")));
  return <text>{"*".repeat(value.length)}</text>;
}

export function Init({ ui, deps = {} }: { ui: Ui; deps?: Partial<InitDeps> }) {
  const d = { ...initDeps, ...deps };
  const renderer = useRenderer();
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>("intro");
  const [note, setNote] = useState("");
  const [catalog, setCatalog] = useState(d.loadCatalog);
  const [costs] = useState(d.harnessCosts);
  const [profile, setProfile] = useState<Profile>(defaultProfile);
  const [backends, setBackends] = useState<BackendStatus[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const pink = tint("pink", ui.depth);

  // Any key finishes, once the "done" message has actually had a chance to sit on screen:
  // destroying the renderer immediately tears down the render tree, so a frame captured
  // right after would show nothing, and a real terminal would lose the message the same way.
  useKeyboard(() => {
    if (phase === "done") renderer.destroy();
  });

  const check = async (key: string, typed: boolean) => {
    setPhase("testing");
    const ok = await d.testJevKey(key).catch(() => false);
    if (!ok) {
      setNote(
        typed
          ? "Jev did not accept that key. Check it at typesafe.ai and paste it again."
          : "The saved Jev key did not answer. Paste a new one.",
      );
      setPhase("key");
      return;
    }
    if (typed) d.saveJevKey(key);
    setNote("");
    setPhase("backends");
    setBackends(await d.detectBackends());
    setPhase("matrix");
  };

  const afterIntro = () => {
    if (started.current) return;
    started.current = true;
    const saved = d.jevKey();
    if (saved) void check(saved, false);
    else setPhase("key");
  };

  const accept = () => {
    const errs = validateProfile(profile, catalog);
    setErrors(errs);
    if (errs.length > 0) return;
    d.save(profile, catalog);
    setPhase("done");
  };

  if (phase === "intro") {
    return <Intro ui={ui} onDone={afterIntro} />;
  }

  const hint =
    phase === "matrix" ? matrixHint(ui, "accept", showHelp) : phase === "done" ? "press any key" : "";
  return (
    <Frame ui={ui} title={title(phase, ui.plain)} hint={hint}>
      {phase === "key" ? (
        <box style={{ flexDirection: "column" }}>
          <text>Paste your TypeSafe API key. Jev uses it to pick each lane's model and effort.</text>
          <box style={{ flexDirection: "row" }}>
            <text>key: </text>
            <MaskedKeyInput
              onSubmit={(k) => {
                if (k.trim()) void check(k.trim(), true);
              }}
            />
          </box>
        </box>
      ) : null}
      {phase === "testing" ? <CatSpinner ui={ui} label="asking Jev a test question" /> : null}
      {phase === "backends" ? <CatSpinner ui={ui} label="sniffing out codex and opencode" /> : null}
      {phase === "matrix" ? (
        <box style={{ flexDirection: "column" }}>
          {backends.map((b) => (
            <BackendLine key={b.backend} ui={ui} b={b} />
          ))}
          <Matrix
            ui={ui}
            profile={profile}
            catalog={catalog}
            backends={backends}
            costs={costs}
            errors={errors}
            reloadCatalog={d.loadCatalog}
            onChange={(p) => {
              setProfile(p);
              setErrors([]);
            }}
            onCatalog={setCatalog}
            onSubmit={accept}
            onQuit={() => {
              process.exitCode = 1;
              renderer.destroy();
            }}
            onToggleHelp={() => setShowHelp((v) => !v)}
          />
        </box>
      ) : null}
      {phase === "done" ? (
        <box style={{ flexDirection: "column" }}>
          <text>{`Saved profile ${profile.name} and its Claude agents.`}</text>
          <text>Now add the plugin in Claude Code:</text>
          {PLUGIN_STEPS.map((s) => (
            <text key={s} fg={tint("ginger", ui.depth)}>{`  ${s}`}</text>
          ))}
          <text>Then start a new Claude Code session: it picks up the agents.</text>
          <text attributes={TextAttributes.DIM}>Press any key to finish.</text>
        </box>
      ) : null}
      {note ? (
        <text fg={pink} wrapMode="none" truncate>
          {note}
        </text>
      ) : null}
    </Frame>
  );
}
