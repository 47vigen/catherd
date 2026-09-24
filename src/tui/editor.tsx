import { TextAttributes } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useState } from "react";
import { type HarnessCost, harnessCosts } from "../core/harness.ts";
import { listRuns } from "../core/runstore.ts";
import {
  activeProfileName,
  defaultProfile,
  listProfiles,
  loadProfile,
  validateProfile,
} from "../profile/profile.ts";
import { loadCatalog } from "../routing/catalog.ts";
import type { Catalog, Profile } from "../types.ts";
import { type BackendStatus, detectBackends } from "./backends.ts";
import { Matrix } from "./matrix.tsx";
import { deleteProfile, nameError, saveAndActivate } from "./profiles.ts";
import { face, glyph, type Mood, tint, type Ui } from "./theme.ts";
import { CatSpinner, Header, Screen } from "./ui.tsx";

export interface EditorDeps {
  loadCatalog: () => Catalog;
  detectBackends: () => Promise<BackendStatus[]>;
  harnessCosts: () => HarnessCost[];
  save: (p: Profile, c: Catalog) => void;
}

const editorDeps: EditorDeps = {
  loadCatalog,
  detectBackends,
  harnessCosts: () => harnessCosts(listRuns().map((r) => r.dir)),
  save: saveAndActivate,
};

type Ask = "new" | "copy" | "delete" | "quit" | null;

function openBook(): { profiles: Profile[]; idx: number } {
  const names = listProfiles();
  const profiles = names.length > 0 ? names.map((n) => loadProfile(n)) : [defaultProfile()];
  const active = activeProfileName();
  return {
    profiles,
    idx: Math.max(
      0,
      profiles.findIndex((p) => p.name === active),
    ),
  };
}

export function Editor({ ui, deps = {} }: { ui: Ui; deps?: Partial<EditorDeps> }) {
  const d = { ...editorDeps, ...deps };
  const renderer = useRenderer();
  const exit = () => renderer.destroy();
  const [catalog, setCatalog] = useState(d.loadCatalog);
  const [costs] = useState(d.harnessCosts);
  const [backends, setBackends] = useState<BackendStatus[] | null>(null);
  const [book, setBook] = useState(openBook);
  const [active, setActive] = useState(activeProfileName);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState<Ask>(null);
  const profile = book.profiles[book.idx] as Profile;
  const pink = tint("pink", ui.depth);
  const dot = ` ${glyph("dot", ui.plain)} `;

  useEffect(() => {
    d.detectBackends().then(setBackends, () => setBackends([]));
  }, []);

  const mark = (name: string, on: boolean) => {
    const next = new Set(dirty);
    if (on) next.add(name);
    else next.delete(name);
    setDirty(next);
  };

  const put = (p: Profile) => {
    setBook({ profiles: book.profiles.map((x, i) => (i === book.idx ? p : x)), idx: book.idx });
    mark(p.name, true);
    setErrors([]);
    setNote("");
  };

  const save = () => {
    const errs = validateProfile(profile, catalog);
    setErrors(errs);
    if (errs.length > 0) return;
    d.save(profile, catalog);
    mark(profile.name, false);
    setActive(profile.name);
    setNote(`Saved ${profile.name}; it is active now. New Claude Code sessions get its agents.`);
  };

  const add = (name: string) => {
    const err = nameError(
      name,
      book.profiles.map((p) => p.name),
    );
    setAsk(null);
    if (err) {
      setNote(err);
      return;
    }
    const base = ask === "new" ? defaultProfile() : structuredClone(profile);
    setBook({ profiles: [...book.profiles, { ...base, name }], idx: book.profiles.length });
    mark(name, true);
    setNote("");
  };

  const remove = () => {
    if (book.profiles.length === 1) {
      setNote("Keep at least one profile.");
      return;
    }
    try {
      if (listProfiles().includes(profile.name)) deleteProfile(profile.name);
    } catch (e) {
      setNote((e as Error).message);
      return;
    }
    mark(profile.name, false);
    setBook({ profiles: book.profiles.filter((_, i) => i !== book.idx), idx: 0 });
    setNote(`Deleted ${profile.name}.`);
  };

  const onKey = (input: string) => {
    setNote("");
    if (input === "p") {
      setBook({ ...book, idx: (book.idx + 1) % book.profiles.length });
      setErrors([]);
    } else if (input === "n") setAsk("new");
    else if (input === "c") setAsk("copy");
    else if (input === "x") setAsk("delete");
  };

  useKeyboard((key) => {
    if (ask === "new" || ask === "copy") {
      if (key.name === "escape") setAsk(null);
      return;
    }
    if (ask === "quit") {
      if (key.sequence === "q") exit();
      setAsk(null);
      return;
    }
    if (ask === "delete") {
      if (key.sequence === "y") remove();
      setAsk(null);
    }
  });

  const mood: Mood =
    backends === null
      ? "working"
      : errors.length > 0
        ? "failed"
        : dirty.has(profile.name)
          ? "waiting"
          : "good";

  return (
    <Screen>
      <Header ui={ui} mood={mood} title={`profiles${dot}${profile.name}`} />
      <text wrapMode="none" truncate>
        {`profile ${profile.name} ${book.idx + 1}/${book.profiles.length}${
          profile.name === active ? " (active)" : ""
        }${dirty.has(profile.name) ? " (unsaved)" : ""}`}
        <span attributes={TextAttributes.DIM}>{`${dot}p next${dot}n new${dot}c copy${dot}x delete`}</span>
      </text>
      {backends === null ? (
        <CatSpinner ui={ui} label="sniffing out codex and opencode" />
      ) : (
        <Matrix
          key={profile.name}
          ui={ui}
          profile={profile}
          catalog={catalog}
          backends={backends}
          costs={costs}
          reloadCatalog={d.loadCatalog}
          onChange={put}
          onCatalog={setCatalog}
          onSubmit={save}
          onQuit={() => (dirty.size > 0 ? setAsk("quit") : exit())}
          onKey={onKey}
          active={ask === null}
        />
      )}
      {ask === "new" || ask === "copy" ? (
        <box style={{ flexDirection: "row" }}>
          <text>
            {ask === "new" ? "Name for the new profile: " : `Name for the copy of ${profile.name}: `}
          </text>
          {/* React 19's DOMAttributes adds a DOM `onSubmit(event: SubmitEvent)` overload to every
              intrinsic element, including OpenTUI's non-DOM <input>; `as any` sidesteps that
              phantom overload rather than fighting it with a full-signature cast. */}
          <input focused onSubmit={add as any} />
        </box>
      ) : null}
      {ask === "delete" ? (
        <text fg={pink}>{`Delete profile ${profile.name}? y deletes it, any other key keeps it.`}</text>
      ) : null}
      {ask === "quit" ? (
        <text fg={pink} wrapMode="none" truncate>
          {`Unsaved changes in ${[...dirty].join(", ")}. q quits without saving, any other key stays.`}
        </text>
      ) : null}
      {errors.map((e) => (
        <text key={e} fg={pink} wrapMode="none" truncate>
          {`${face("failed", ui.plain)} ${e}`}
        </text>
      ))}
      {note ? (
        <text wrapMode="none" truncate>
          {note}
        </text>
      ) : null}
    </Screen>
  );
}
