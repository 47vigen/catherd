import { useEffect, useMemo, useRef, useState } from "react";
import { type Profile, resolveProfile } from "../../../domain/profile.ts";
import type { Role } from "../../../domain/roles.ts";
import { errorMessage, isCatherdError } from "../../../domain/errors.ts";
import { hereWord } from "../effects.ts";
import { useApp, useDialogHandler } from "../providers/app.tsx";
import { type Data, useData, useLoad } from "../providers/data.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { errorToast } from "../providers/toast.tsx";
import { useUi } from "../providers/theme.tsx";
import {
  failoverOptions,
  numberPatch,
  numberValue,
  parseNumber,
  patchFor,
  startOptions,
  treatLikeOptions,
} from "../profile-edits.ts";
import { buildRows, filterRows, firstMatch, type Row, type RowAction, withStaged } from "../profile-tree.ts";
import { currentDraft, dirtyCount } from "../state.ts";
import { wrap } from "../text.ts";
import { glyph, STATE_TOKEN } from "../theme.ts";
import { Line, type Part } from "../widgets/line.tsx";
import { List, type ListItem, useSelected } from "../widgets/list.tsx";
import { openActivate, openNewProfile, openRevert, openSave, showProfile } from "./profile-actions.ts";

/** What a row does, for the line under the tree when it has no issue. */
const ABOUT: Partial<Record<RowAction["type"], string>> = {
  role: "space turns the role on or off; enter opens its access, default rung and models",
  access:
    "enter cycles read-only → workspace-write → full; enforced: the backend stops a write, advisory: it is only asked",
  start: "enter picks where a lane starts without a kind and difficulty",
  model: "enter opens its efforts; space never changes a rung",
  rung: "space ticks this rung onto the role's ladder; routing orders the ladder by cost",
  objective: "enter switches between cost and speed",
  jev: "enter turns Jev on (auto: when a key exists) or off",
  isolated: "space runs the backend with catherd's own config instead of yours",
  number: "enter edits the value",
  failover: "enter picks the stand-in on a usage limit; it runs on a fresh thread",
  notify: "space turns this notification on or off",
};

/** Spec 1.3 §8: a harness row's line: what isolating it needs, and what its native mode loads. */
export const isolationAbout = (i: { note?: string; key?: string }): string =>
  [`${ABOUT.isolated}${i.key ? ` (it needs ${i.key})` : ""}`, i.note].filter(Boolean).join("; ");

/**
 * The profiles poll failed after a good read (its error is newer than the value it keeps): one error line
 * and, when the failure says, its fix; none once a read succeeds again.
 */
export function staleLines(data: Data, plain: boolean, o: { fix?: boolean } = {}): Part[] {
  const p = data.profiles;
  if (p.error === null || p.value === null) return [];
  const said: Part[] = [
    {
      text: ` ${glyph("fail", plain)} could not read the profiles again: ${p.error} · showing the last good read`,
      tone: "error",
    },
  ];
  if (p.fix && o.fix !== false) said.push({ text: ` fix: ${p.fix}`, tone: "muted" });
  return said;
}

/** Only ticking an unscored effort asks for a treat-like; unticking a rung always just unticks it. */
const needsTreatLike = (p: Profile, a: RowAction): boolean =>
  a.type === "rung" && !a.scored && !p.roles[a.role].rungs.includes(a.rung);

/**
 * Spec §9.1 tab 2: the profile's line, then one tree (roles → access + backend → model → efforts, then
 * routing, harness, budget, failover, timeouts, notify), then a line about the selected row. Every edit
 * is staged in the draft; nothing is written before ctrl+s.
 */
export function ProfilesView(props: { width: number; height: number }) {
  const app = useApp();
  const data = useData();
  const ui = useUi();
  const { selected, select: setSelected, current: selectedNow } = useSelected();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["role:worker"]));
  const [filter, setFilter] = useState<string | null>(null);
  const draft = currentDraft(app.state);
  const here = data.profiles.value?.here ?? null;
  // the profile the tab opens on; a read of it that fails is shown in the tab (below), and read again
  // on r and after every good poll of the profiles
  const [openFailed, setOpenFailed] = useState<{ name: string; error: string; fix: string | null } | null>(
    null,
  );
  const [openTries, setOpenTries] = useState(0);
  const polledAt = data.profiles.at;
  useEffect(() => {
    if (app.state.profile || !here) return;
    const e = showProfile(app, here, { quiet: true });
    setOpenFailed(
      e === null
        ? null
        : {
            name: here,
            error: errorMessage(e),
            fix: isCatherdError(e) && e.fix ? e.fix : null,
          },
    );
  }, [app.state.profile, here, app, polledAt, openTries]);
  const profile = useMemo(() => (draft ? resolveProfile(draft.doc, draft.name, draft.host) : null), [draft]);
  const billingKey = JSON.stringify(profile?.billing ?? {});
  // read again after every save too, by the identity of the base it reads back (the same bytes when only
  // treat-likes changed): a save writes the staged treat-likes to the catalog override and clears them
  // from the draft, so the catalog read before it would lack them
  const reads = useRef(0);
  const savedKey = useMemo(() => ++reads.current, [draft?.base]);
  const loaded = useLoad(
    () => (profile ? app.effects.catalog(profile.billing) : null),
    `${billingKey}|${savedKey}`,
  );
  const catalog = useMemo(
    () => (loaded.value && draft ? withStaged(loaded.value.catalog, draft.treatLikes) : null),
    [loaded.value, draft],
  );
  const validation = useMemo(
    () => (profile && catalog ? app.effects.validate(profile, catalog) : { errors: [], warnings: [] }),
    [profile, catalog, app.effects],
  );
  const rows: Row[] = useMemo(() => {
    if (!profile || !catalog || !loaded.value || !draft) return [];
    const all = buildRows({
      profile,
      models: loaded.value.models,
      catalog,
      staged: draft.treatLikes,
      expanded,
      harnesses: app.effects.harnesses,
      enforcement: app.effects.enforcement,
      validation,
      expandAll: Boolean(filter),
    });
    return filter ? filterRows(all, filter) : all;
  }, [profile, catalog, loaded.value, draft, expanded, filter, validation, app.effects]);
  // a read that failed is shown with its fix and a retry, not as one still pending: the profiles (no
  // draft can open without them; the 2 s poll also reads them again) or, once a profile shows, the catalog
  const failure =
    !draft && data.profiles.error !== null
      ? {
          what: "the profiles",
          error: data.profiles.error,
          fix: data.profiles.fix,
          retry: data.profiles.refresh,
          polled: true,
        }
      : !draft && openFailed
        ? {
            what: `the profile ${openFailed.name}`,
            error: openFailed.error,
            fix: openFailed.fix,
            retry: () => setOpenTries((n) => n + 1),
            polled: true,
          }
        : profile && loaded.error !== null && !loaded.value
          ? {
              what: "the catalog",
              error: loaded.error,
              fix: loaded.fix,
              retry: loaded.refresh,
              polled: false,
            }
          : null;
  // a later read that failed over a kept good one: said under the header until a read succeeds, like the
  // Runs tab over its kept rows; the draft stays open and editable
  const stale = draft ? staleLines(data, ui.plain) : [];
  const row = rows.find((r) => r.key === selected) ?? null;
  /** the row the cursor is on now, which a key earlier in the same tick may have moved */
  const rowNow = () => rows.find((r) => r.key === selectedNow()) ?? null;
  // typing a filter puts the cursor on the first row that matches it; an edit under a kept filter
  // (new rows, same text) leaves the cursor where it is
  const placedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!filter) {
      placedFor.current = null;
      return;
    }
    if (filter === placedFor.current) return;
    const m = firstMatch(rows, filter);
    if (!m) return;
    placedFor.current = filter;
    setSelected(m.key);
  }, [filter, rows]);
  /** the draft as it is now: two keys in one tick must not both edit the profile this render drew */
  const current = () => {
    const d = currentDraft(app.getState());
    return d ? resolveProfile(d.doc, d.name, d.host) : null;
  };
  const edit = (patch: ReturnType<typeof patchFor>) => patch && app.dispatch({ type: "edit", patch });
  const toggleOpen = (r: Row, open?: boolean) =>
    setExpanded((e) => {
      const next = new Set(e);
      if (open ?? !next.has(r.key)) next.add(r.key);
      else next.delete(r.key);
      return next;
    });
  const pick = (r: Row) => {
    if (!profile || !loaded.value || !catalog) return;
    const a = r.action;
    if (a.type === "start")
      app.dispatch({
        type: "open",
        dialog: {
          kind: "select",
          purpose: { type: "start", role: a.role },
          title: `Default rung for ${a.role}`,
          options: startOptions(profile, a.role),
          empty: "no rungs",
        },
      });
    else if (a.type === "failover")
      app.dispatch({
        type: "open",
        dialog: {
          kind: "select",
          purpose: { type: "failover", rung: a.rung },
          title: `Stand-in for ${a.rung}`,
          options: failoverOptions(profile, loaded.value.models, catalog, a.rung),
          empty: "no scored rung on another quota",
        },
      });
    else if (a.type === "rung" && !a.scored) openTreatLike(a.rung, a.role);
    else if (a.type === "number") {
      const v = numberValue(profile, a.path);
      app.dispatch({
        type: "open",
        dialog: {
          kind: "prompt",
          purpose: { type: "number", path: a.path },
          title: `Set ${a.path}`,
          label: a.path.startsWith("budget.") ? "a number above 0; empty for no cap" : "minutes, above 0",
          value: v === undefined ? "" : String(v),
          error: null,
        },
      });
    }
  };
  /** spec 1.2 §6.4: the treat-like picker, its three nearest stand-ins first */
  const openTreatLike = (rung: string, role: Role | null) => {
    if (!catalog) return;
    const suggestions = app.effects.suggest(catalog, rung);
    app.dispatch({
      type: "open",
      dialog: {
        kind: "select",
        purpose: { type: "treatLike", rung, role },
        title: `Treat ${rung} like…`,
        options: treatLikeOptions(catalog, suggestions),
        suggested: suggestions.map((s) => s.like),
        empty: "no scored rung",
      },
    });
  };
  /** spec 1.2 §9: the rung's values with confidence and source, and catherd's runs on it */
  const openDetail = (rung: string) => {
    if (!catalog) return;
    const d = app.effects.rungDetail(catalog, rung);
    app.dispatch({
      type: "open",
      dialog: {
        kind: "select",
        purpose: { type: "rung", rung },
        title: rung,
        options: [
          ...d.values.map((v) => ({
            value: v.dim,
            title: `${v.dim} ${v.value}`,
            group: "values",
            detail: `${v.lent === "treat-like" ? `like ${v.from}` : v.inferred ? `inferred from ${v.from}` : v.confidence} · ${v.source} ${v.benchmark} · ${v.date}`,
          })),
          {
            value: "runs",
            title: d.evidence ?? "no runs yet",
            group: "catherd's runs (never used to route)",
          },
        ],
        empty: "no values",
      },
    });
  };
  const primary = (r: Row | null) => {
    const p = current();
    if (!r || !p) return;
    const a = r.action;
    if (a.type === "role" || a.type === "model") return toggleOpen(r);
    if (a.type === "start" || a.type === "failover" || a.type === "number" || needsTreatLike(p, a))
      return pick(r);
    edit(patchFor(p, a));
  };
  const toggle = (r: Row | null) => {
    const p = current();
    if (!r || !p) return;
    const a = r.action;
    if (a.type === "model") return toggleOpen(r);
    if (needsTreatLike(p, a)) return pick(r);
    if (a.type === "role" || a.type === "rung" || a.type === "isolated" || a.type === "notify")
      edit(patchFor(p, a));
  };
  useCommandLayer("tab.profiles", {
    "profile.save": () => openSave(app),
    "profile.activate": () => openActivate(app, data),
    "profile.copy": () => draft && openNewProfile(app, draft.name),
    "profile.revert": () => openRevert(app),
    "catalog.refresh": () => {
      // after a failed read, r reads it again (and only that)
      if (failure) return failure.retry();
      // spec 1.2 §9: r lists every backend's models and syncs the public sources, then shows each source's
      // age and last error
      void Promise.all([app.effects.refreshCatalog(), app.effects.syncSources()]).then(
        ([, sync]) => {
          loaded.refresh();
          app.toast({
            variant: sync.failed.length ? "warning" : "success",
            message: sync.busy
              ? "Catalog refreshed; another sync is running"
              : `Catalog refreshed${sync.newlyScored.length ? `; ${sync.newlyScored.length} rungs newly scored` : ""}`,
          });
          app.dispatch({
            type: "open",
            dialog: {
              kind: "select",
              purpose: { type: "sources" },
              title: "Sources",
              options: app.effects.sources().map((s) => ({
                value: s.source,
                title: s.name,
                detail: s.error ? `${s.age} · ${s.error}` : s.age,
              })),
              empty: "no sources",
            },
          });
        },
        (e: unknown) => app.toast(errorToast(e)),
      );
    },
    "edit.undo": () => app.dispatch({ type: "undo" }),
    "edit.redo": () => app.dispatch({ type: "redo" }),
  });
  useCommandLayer("row.profiles", {
    "tree.detail": () => {
      const a = rowNow()?.action;
      if (a?.type === "rung") openDetail(a.rung);
      else app.toast({ variant: "info", message: "Pick a rung (an effort row) to see its values" });
    },
    "tree.treatLike": () => {
      const a = rowNow()?.action;
      if (a?.type === "rung") openTreatLike(a.rung, a.role);
      else app.toast({ variant: "info", message: "Pick a rung (an effort row) to map it" });
    },
    "tree.toggle": () => toggle(rowNow()),
    "tree.open": () => primary(rowNow()),
    "tree.expand": () => {
      const row = rowNow();
      if (row?.expandable) toggleOpen(row, true);
    },
    "tree.collapse": () => {
      const row = rowNow();
      if (!row) return;
      if (row.expandable && row.expanded) return toggleOpen(row, false);
      let p = rows.find((r) => r.key === row.parent);
      while (p && !p.selectable) p = rows.find((r) => r.key === p?.parent);
      if (p) setSelected(p.key);
    },
  });
  useDialogHandler("start", (p, value) => {
    app.dispatch({ type: "close" });
    if (p.type === "start") edit({ roles: { [p.role]: { defaultRung: value || null } } });
  });
  useDialogHandler("failover", (p, value) => {
    app.dispatch({ type: "close" });
    if (p.type === "failover") edit({ failover: { [p.rung]: value || null } });
  });
  useDialogHandler("treatLike", (p, value) => {
    app.dispatch({ type: "close" });
    const prof = current();
    if (p.type !== "treatLike" || !prof) return;
    // one undo step: the treat-like and the tick it brings
    const tick =
      p.role && !prof.roles[p.role].rungs.includes(p.rung)
        ? patchFor(prof, { type: "rung", role: p.role, rung: p.rung, scored: true })
        : null;
    app.dispatch({ type: "treatLike", rung: p.rung, like: value, ...(tick ? { patch: tick } : {}) });
  });
  useDialogHandler("sources", () => app.dispatch({ type: "close" }));
  useDialogHandler("rung", () => app.dispatch({ type: "close" }));
  useDialogHandler("number", (p, value) => {
    if (p.type !== "number") return;
    const r = parseNumber(p.path, value);
    if ("error" in r) return app.dispatch({ type: "invalid", error: r.error });
    app.dispatch({ type: "close" });
    edit(numberPatch(p.path, r.value));
  });

  const unsaved = draft ? dirtyCount(draft) : 0;
  const top: Part[] = draft
    ? [
        { text: " PROFILE ", bold: true },
        { text: draft.name, bold: true },
        {
          text: draft.name === here ? ` (${hereWord(data.profiles.value ?? { repo: null })})` : "",
          tone: "muted",
        },
        { text: unsaved ? ` · ${unsaved} unsaved` : "", tone: "warning" },
        { text: `   ${glyph("dot", ui.plain)} ctrl+x l switch · ctrl+x n new`, tone: "muted" },
      ]
    : failure
      ? [{ text: " PROFILE", bold: true }]
      : [{ text: " reading the profile…", tone: "muted" }];
  const about = row?.issue
    ? [
        {
          text: ` ${glyph(row.issue.level === "error" ? "fail" : "warn", ui.plain)} ${row.issue.message}`,
          tone: STATE_TOKEN[row.issue.level === "error" ? "fail" : "warn"],
        },
        ...(row.issue.fix ? [{ text: ` fix: ${row.issue.fix}`, tone: "muted" as const }] : []),
      ]
    : [
        {
          text: ` ${
            row?.action.type === "isolated"
              ? isolationAbout(app.effects.isolation(row.action.harness))
              : ((row && ABOUT[row.action.type]) ?? "")
          }`,
          tone: "muted" as const,
        },
      ];
  const aboutLines = about
    .flatMap((p) => wrap(p.text, props.width).map((text) => ({ ...p, text })))
    .slice(0, 2);
  // the value column of a group of rows starts after its longest label, so long model names line up
  const widest = new Map<string | null, number>();
  for (const r of rows)
    if (r.selectable) widest.set(r.parent, Math.max(widest.get(r.parent) ?? 0, Bun.stringWidth(r.label)));
  const items: ListItem[] = rows.map((r) => ({
    key: r.key,
    selectable: r.selectable,
    render: (sel, w) => {
      const indent = "  ".repeat(r.depth);
      const marker = r.expandable ? `${glyph(r.expanded ? "open" : "shut", ui.plain)} ` : "  ";
      const check = r.check === null ? "" : `${glyph(r.check ? "on" : "off", ui.plain)} `;
      const issue = r.issue ? ` ${glyph(r.issue.level === "error" ? "fail" : "warn", ui.plain)}` : "";
      if (!r.selectable)
        return (
          <Line
            width={w}
            parts={[
              {
                text: ` ${indent}${r.label}`,
                bold: r.depth === 0,
                tone: r.depth === 0 ? undefined : "muted",
              },
              { text: r.value ? `  ${r.value}` : "", tone: "muted" },
            ]}
          />
        );
      const labelWidth = Math.max(14, 30 - r.depth * 2, (widest.get(r.parent) ?? 0) + 2);
      return (
        <Line
          width={w}
          selected={sel}
          dim={r.dim}
          parts={[
            { text: ` ${indent}${marker}${check}` },
            {
              text: r.label.length + 2 > labelWidth ? `${r.label}  ` : r.label.padEnd(labelWidth),
              bold: r.depth === 1,
            },
            { text: r.value, tone: "muted" },
            { text: issue, tone: r.issue?.level === "error" ? "error" : "warning" },
          ]}
        />
      );
    },
  }));
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <Line width={props.width} parts={top} />
      {stale.map((p, i) => (
        <Line key={`stale${i}`} width={props.width} parts={[p]} />
      ))}
      {failure ? (
        <box flexDirection="column" width={props.width} height={props.height - 3}>
          {[
            ...wrap(
              ` ${glyph("fail", ui.plain)} could not read ${failure.what}: ${failure.error}`,
              props.width,
            ).map((text): Part => ({ text, tone: "error" })),
            ...(failure.fix ? wrap(` fix: ${failure.fix}`, props.width) : []).map((text): Part => ({
              text,
              tone: "muted",
            })),
            {
              text: ` r retry${failure.polled ? " · also read again every 2 s" : ""}`,
              tone: "muted",
            } as Part,
          ]
            .slice(0, Math.max(0, props.height - 3))
            .map((p, i) => (
              <Line key={i} width={props.width} parts={[p]} />
            ))}
        </box>
      ) : (
        <List
          items={items}
          selected={selected}
          onSelect={setSelected}
          width={props.width}
          height={props.height - 3 - stale.length}
          filter={filter}
          onFilter={setFilter}
          empty="reading the catalog…"
        />
      )}
      {[0, 1].map((i) => (
        <Line key={i} width={props.width} parts={aboutLines[i] ? [aboutLines[i]] : []} />
      ))}
    </box>
  );
}
