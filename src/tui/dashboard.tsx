import { readFileSync } from "node:fs";
import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import { countLinkedAgents } from "../profile/agents.ts";
import { activeProfileName } from "../profile/profile.ts";
import { loadCatalog } from "../routing/catalog.ts";
import { jevKey } from "../routing/jev.ts";
import type { Catalog } from "../types.ts";
import { type BackendStatus, detectBackends } from "./backends.ts";
import { Editor } from "./editor.tsx";
import { Init } from "./init.tsx";
import { dot, type DotState, dotTint, glyph, type Mood, tint, type Ui } from "./theme.ts";
import { DetailPane, Frame, ListLine, Wordmark } from "./ui.tsx";
import { Watch } from "./watch.tsx";

export interface DashboardDeps {
  detectBackends: () => Promise<BackendStatus[]>;
  jevKey: () => string | null;
  loadCatalog: () => Catalog;
  countLinkedAgents: () => number;
  activeProfileName: () => string;
  version: string;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

const dashboardDeps: DashboardDeps = {
  detectBackends,
  jevKey,
  loadCatalog,
  countLinkedAgents,
  activeProfileName,
  version: readVersion(),
};

type Screen = "dashboard" | "profile" | "watch" | "setup";

interface Action {
  screen: Screen | "refresh" | "exit";
  label: string;
  subtitle: string;
  description: string;
}

const ACTIONS: Action[] = [
  {
    screen: "profile",
    label: "Profile",
    subtitle: "roles, routing, budget",
    description: "Edit which models fill each role, and how catherd escalates between them.",
  },
  {
    screen: "watch",
    label: "Watch runs",
    subtitle: "live and recent runs",
    description: "See what is running now, and how past runs went.",
  },
  {
    screen: "setup",
    label: "Setup",
    subtitle: "Jev key & backends",
    description: "Re-run first-time setup: the Jev key, Codex/opencode, and a starting profile.",
  },
  {
    screen: "refresh",
    label: "Refresh catalog",
    subtitle: "reload models & scores",
    description: "Re-read the model catalog from disk, in case it changed underneath catherd.",
  },
  {
    screen: "exit",
    label: "Exit",
    subtitle: "quit catherd",
    description: "Leave catherd without changing anything.",
  },
];

interface Status {
  backends: BackendStatus[];
  jev: boolean;
  agents: number;
  active: string;
}

function backendState(b: BackendStatus | undefined, plain: boolean): { state: DotState; text: string } {
  if (!b || !b.installed) return { state: "missing", text: "not installed" };
  if (!b.loggedIn) {
    return {
      state: "warn",
      text: b.version ? `${b.version} ${glyph("dot", plain)} not logged in` : "not logged in",
    };
  }
  return { state: "ready", text: b.version ?? "ready" };
}

function StatusRow({ ui, state, name, value }: { ui: Ui; state: DotState; name: string; value: string }) {
  return (
    <text wrapMode="none" truncate>
      <span fg={dotTint(state, ui.depth)}>{dot(state, ui.plain)}</span> {name.padEnd(16)}
      <span attributes={TextAttributes.DIM}>{value}</span>
    </text>
  );
}

function mood(status: Status | null): Mood {
  if (!status) return "working";
  const trouble = status.backends.some((b) => !b.installed || !b.loggedIn) || !status.jev;
  return trouble ? "waiting" : "good";
}

/** The bare `catherd` screen: an actions menu on the left, and the selected action's detail
 * plus a live status snapshot on the right. Selecting Profile/Watch/Setup swaps this same
 * mounted tree for that screen, in place — no new process, no re-mount of the renderer. */
export function Dashboard({ ui, deps = {} }: { ui: Ui; deps?: Partial<DashboardDeps> }) {
  const d = { ...dashboardDeps, ...deps };
  const renderer = useRenderer();
  const [cursor, setCursor] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [note, setNote] = useState("");

  const refresh = () => {
    d.detectBackends().then(
      (backends) =>
        setStatus({
          backends,
          jev: d.jevKey() !== null,
          agents: d.countLinkedAgents(),
          active: d.activeProfileName(),
        }),
      () => setStatus({ backends: [], jev: false, agents: 0, active: d.activeProfileName() }),
    );
  };

  // spec: no new network calls on every keystroke — backends are probed once on mount, and
  // again only when the user asks for it with `r`.
  useEffect(refresh, []);

  const activate = () => {
    const a = ACTIONS[cursor];
    if (!a) return;
    if (a.screen === "exit") renderer.destroy();
    else if (a.screen === "refresh") {
      d.loadCatalog();
      setNote("Catalog reloaded.");
    } else setScreen(a.screen);
  };

  useKeyboard((key) => {
    if (screen !== "dashboard") return;
    if (key.name === "up") setCursor((v) => Math.max(0, v - 1));
    else if (key.name === "down") setCursor((v) => Math.min(ACTIONS.length - 1, v + 1));
    else if (key.name === "return") activate();
    else if (key.sequence === "r") refresh();
    else if (key.sequence === "q") renderer.destroy();
  });

  if (screen === "profile") return <Editor ui={ui} />;
  if (screen === "watch") return <Watch ui={ui} />;
  if (screen === "setup") return <Init ui={ui} />;

  const a = ACTIONS[cursor] as Action;
  const codex = status
    ? backendState(
        status.backends.find((b) => b.backend === "codex"),
        ui.plain,
      )
    : null;
  const opencode = status
    ? backendState(
        status.backends.find((b) => b.backend === "opencode"),
        ui.plain,
      )
    : null;

  return (
    <Frame
      ui={ui}
      title="catherd"
      hint={`${glyph("keys", ui.plain)} navigate   Enter open   r refresh   q exit`}
      above={<Wordmark ui={ui} mood={mood(status)} suffix={d.version} />}
    >
      <box style={{ flexDirection: "row" }}>
        <box style={{ flexDirection: "column", width: 22 }}>
          <text fg={tint("pink", ui.depth)} attributes={TextAttributes.BOLD}>
            ACTIONS
          </text>
          {ACTIONS.map((act, i) => (
            <ListLine key={act.label} ui={ui} selected={i === cursor} text={act.label} />
          ))}
        </box>
        <DetailPane ui={ui} heading="SELECTED ACTION" title={a.label} subtitle={a.subtitle}>
          <text attributes={TextAttributes.DIM} wrapMode="word">
            {a.description}
          </text>
          <text> </text>
          <text fg={tint("pink", ui.depth)} attributes={TextAttributes.BOLD}>
            CURRENT SETUP
          </text>
          {status ? (
            <>
              <StatusRow
                ui={ui}
                state={status.jev ? "ready" : "missing"}
                name="Jev key"
                value={status.jev ? "set" : "missing"}
              />
              <StatusRow ui={ui} state={codex?.state ?? "missing"} name="Codex" value={codex?.text ?? ""} />
              <StatusRow
                ui={ui}
                state={opencode?.state ?? "missing"}
                name="opencode"
                value={opencode?.text ?? ""}
              />
              <StatusRow
                ui={ui}
                state={status.agents > 0 ? "ready" : "warn"}
                name="Claude agents"
                value={`${status.agents} linked`}
              />
              <StatusRow ui={ui} state="ready" name="Active profile" value={status.active} />
            </>
          ) : (
            <text attributes={TextAttributes.DIM}>checking…</text>
          )}
          {note ? (
            <text fg={tint("pink", ui.depth)} wrapMode="none" truncate>
              {note}
            </text>
          ) : null}
        </DetailPane>
      </box>
    </Frame>
  );
}
