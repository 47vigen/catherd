# Plan 42 — panel: newest-first log, a zoomable graph, honest durations, model names, a Models page, brand colours

Setup: bun install --frozen-lockfile && (cd web && bun install --frozen-lockfile)

Source: the owner-approved panel scope of 2026-10-24 (six items), from the panel research done on the sanipay-credit run. Written against `plans-40-42` at bbc1104. Plan 40 (same run) owns the orchestration core (`src/domain/run-events.ts`, `run-state.ts`, `run-machine.ts`) and adds a start time or duration to `check.ran`; plan 41 owns `src/adapters/opencode/*` and the opencode transcript parser. This plan touches neither. Each fix has a test that fails without it.

UI review (ui-reviewer and verifier): open an authenticated panel on the seeded e2e server, never a real home. From the repo root: `(cd web && catherd lock -- bun run build)`, then start `CATHERD_E2E_STATE=web/test-results/review-state.json CATHERD_E2E_PORT=43<NN> bun test/panel-e2e-serve.ts` in the background (`<NN>` = the milestone number, so M33 uses 4333), wait for its line `panel e2e server on …`, and open `http://127.0.0.1:43<NN>/login?redirect=<path>#token=e2e-token` (the token is fixed; `<path>` URL-encoded, e.g. `%2Fmodels`). `web/test-results/review-state.json` names the seeded runs: `fixture.id` (a finished run with checks, commits and a review) and `live.id` (a running worker with a log). The theme is the sidebar's "Theme" menu (Light, Dark). Viewports 1280×800 and 375×812. Stop the server when done.

## What already exists

- web/src/routes/_app/runs/-components/transcript/TranscriptView.tsx — `useStreamPages` (lines 23–115) reads `getDispatchStream` in pages of `PAGE = 500` from line 0, oldest first; while `live` a full page reads on at once (line 80), otherwise `more` shows "Load more" (lines 194–200); `TranscriptView` (121–203) subscribes to `LiveLogContext` once caught up and folds socket frames with `mergeTranscript`.
- web/src/routes/_app/runs/-components/transcript/TranscriptCards.tsx — `TranscriptCards({ cards, raw, showRaw, query, live })` (155–214): filters by `query`, then maps in order; raw lines keyed `key={i}` (196), cards `key={`${c.line}:${i}`}` (206), so a reversed list would remount every card on each append and close open `<details>` ("Thinking").
- web/src/routes/_app/runs/-components/transcript/merge.ts — `mergeTranscript(cards, items)`: appends, or replaces in place by id; an `output` fills its card. State stays ascending.
- src/services/transcript.ts — `readTranscript(dir, backend, { from, limit, raw, ended })` reads the whole stream per page (comment "upgrade past ~50 MB"); `StreamQuerySchema` (src/entry/panel/openapi.ts:108) allows `limit` 1–2000.
- web/src/routes/_app/runs/-components/graph/RunGraph.tsx — `RunGraph({ model, milestones, selected, now, onOpen })`: a native-scroll `FRAME` (`max-h-[72vh] overflow-auto`, line 36), an invisible `<svg width={w} height={h}>` sizer (128), `<ReactFlow defaultViewport={{ x: PAD, y: PAD, zoom: 1 }} minZoom={1} maxZoom={1}>` with every pan/zoom gesture off (129–153), `key={laid.key}`, `aria-label="Graph of the run"`; `scrollToActive` (83–91) centres the running node in unscaled pixels.
- web/src/routes/_app/runs/$runId.tsx — `stepsAside` (171–189: "N done · N skipped · N failed of M" and the Live dot), `<Tile title="Steps" aside={stepsAside}>` (196) holding `RunGraph` on desktop, `NodeList` on phones; `open(id)` (156–159) navigates `?node=<id>&tab=overview`; `NodeDrawer` is rendered once at page level inside `LiveLogContext` (294–312). No fullscreen exists anywhere in `web/`.
- HeroUI v3 (verified in its docs): `Modal.Backdrop isOpen onOpenChange` + `Modal.Container size="full"` (whole viewport, no margins) + `Modal.Dialog` + `Modal.Header`/`Modal.Heading`/`Modal.Body`/`Modal.CloseTrigger`; `Button isIconOnly size="sm" variant="ghost|secondary"` (used in web/src/routes/_app.tsx:35); `ToggleButtonGroup`/`ToggleButton` (web/src/routes/_app/-dashboard/DailyChart.tsx:25–40); `Switch` (TranscriptView.tsx:158–172). `@gravity-ui/icons` 2.23 has `MagnifierPlus`, `MagnifierMinus`, `ArrowsExpand`, `Frame`, `ChartLine`.
- src/domain/run-graph.ts — `event()` (372–399) builds every event attempt with `at: e.at, endedAt: e.at, secs: null`; `check.ran` (440–448) pushes one `kind: "check"` attempt; node `startedAt` = the oldest attempt's `at`, `endedAt` = the newest `endedAt` (≈ 621–632). So a check that ran once spans 0 s, and one that ran twice spans first to last check.
- web/src/routes/_app/runs/-lib/node-view.ts — `nodeSecs(n, nowMs)` (110–115) = `endedAt − startedAt`; `modelName(id)` (120–132) splits on `-`/`_` only, so `openscale/deepseek/deepseek-v4.1-flash` reads "Openscale/deepseek/deepseek V4.1 Flash". Callers of `nodeSecs`: NodeCard.tsx:75 (prints `formatDuration(secs)` when not null), NodeList.tsx:41, drawer/NodeDrawer.tsx:64, drawer/OverviewTab.tsx:94. Callers of this `modelName`: NodeCard.tsx:115, NodeList.tsx:76, RunSide.tsx:72, OverviewTab.tsx:71, NodeDrawer.tsx:72.
- Two more `modelName` copies, both drop the provider path: web/src/routes/_app/-dashboard/format.ts:111–128 (`modelName(rung)`, strips `backend:` and `#effort`, drops 6+-digit date parts; caller Shares.tsx:51) and web/src/routes/_app/setup/-lib/rung.ts:60–70 (`modelName(model)`; callers PairPicker, ChangePreview, LadderEditor, RolesOverview). Tests: node-view.test.ts:60–63, -dashboard/format.test.ts:90–95, setup/-lib/rung.test.ts:56–61 (expects "Claude Haiku 4.5 20251001").
- src/domain/slopalytics.ts — `SlopRecord`, `RecordSchema` (15–23, a `z.object`, so unlisted keys are stripped), `IndexFileSchema` (`looseObject`, schema 1), `parseProxy(body)` (42–65) keeps 7 fields; the proxy also sends `cost` (measured USD per task), `lab`, `labName`, `name`, `effortOrder` (see test/fixtures/slopalytics-proxy.json). `slopKey(model)`.
- src/domain/catalog.ts — `Pair { intelligence; price; speed; context }` (64–69), `buildCatalog({ models, index, listed })` (85–110), `rungInfo`, `pairOf(c, rung)`.
- src/domain/cost.ts — `taskUsd(price, effort)`: a reference task at list price × the effort factor (an estimate).
- src/services/catalog-service.ts — `loadCatalog({ repo?, runDir? })` (56), `IndexedPair` (173), `CatalogModel` (184: `id`, `name`, `backend`, `model`, `listed`, `rungs`), `catalogQuery(f, billing)` (233–277): one row per family per backend (Claude families on `claude` and `claude-code`), plus listed models catherd has no family for. `CatalogFilter` (src/services/ports.ts:149) `{ role?, backend?, text?, limit, repo? }`.
- src/entry/panel/openapi.ts — `OperationId` union (123), `OPERATIONS` (166; `getSetup` at 185 with `query: SetupQuerySchema`), `SCHEMAS` (302). src/entry/panel/server.ts — `repoOf(c)` (133: absent → the panel's repo, `global` → null), `HANDLERS` (202). `bun run panel:openapi` writes web/openapi.json; `(cd web && bun run gen)` writes web/src/client/. test/entry/panel-openapi.test.ts asserts the file matches and every operation is listed once; test/entry/panel-server.test.ts:797 asserts every operation refuses a request without a session.
- test/fixtures/slopalytics.json — the recorded index every `withHome()` seeds (test/helpers.ts:52) and `fixtureIndex()` reads (test/domain/shipped.ts). Shared with the catalog and routing tests; a parallel change may add records to it.
- web/src/theme.css — light `:root,[data-theme="light"]` (`--surface: oklch(1 0 0)`, `--chart-1..5` at 66–71), dark `.dark,[data-theme="dark"]` (`--surface: oklch(0.185 0.004 250)`, `--chart-1..5` at 128–132), `@theme inline` aliases `--color-chart-N` (140–147). Status colours: `--success` (hue 152), `--warning` (74–76), `--danger` (25–26).
- web/src/routes/_app/-dashboard/format.ts:98–108 — `TONE` (Codex 0, Cursor 1, opencode 2, Claude Code/Claude 4, else 3), `FILL`/`BG` over `--chart-1..5`, `backendTone(backendOrName): { fill; bg }`; callers DailyChart.tsx (bars, legend, tooltip), Shares.tsx:54. Test format.test.ts:97–101.
- web/src/components/provider-icon/ProviderIcon.tsx — `ProviderIcon({ backend, size, className })`, marks drawn in `currentColor` inside a `text-foreground` span; `backendName`, `providerOf`.
- web/src/components/charts/ChartTooltip.tsx — `AXIS_TICK`, `GRID_STROKE`, `ChartTooltip`, `ChartTooltip.Row({ swatch, label, value })`. recharts 3.10 is installed. web/src/components/{page-header/PageHeader.tsx,tile/Tile.tsx,data-list/DataList.tsx} (`DataList.State isLoading error isEmpty emptyText`).
- web/src/routes/_app/-components/Shell.tsx:16–26 `GROUPS` (Watch: Dashboard, Runs, Questions; Configure: Setup); CommandMenu.tsx:11–16 `PAGES`; Shell.test.tsx expects four links (`toHaveLength(4)`); web/e2e/smoke.spec.ts:7–14 `pages()`. web/src/routeTree.gen.ts is generated by the router plugin on `vite build` and checked in.
- web/src/conventions.test.ts — only `index.css` and `theme.css`, no inline `style={}`, no hook files in component folders, no virtualization, English copy, the brand-word regex.
- test/panel-e2e-serve.ts — the seeded panel: `withHome()` (so the recorded Slopalytics index is there), three runs plus the fixture run, token `e2e-token`, port `CATHERD_E2E_PORT` (default 4318), serves `web/dist`; writes its state to `$CATHERD_E2E_STATE`.
- src/services/run-effects.ts:139–140 `planOf` reads a milestone's `After:` from a line inside its `## M<n>` section (not from the heading text).

## Contracts

```ts
// src/domain/slopalytics.ts
export interface SlopRecord { /* … as today */ cost?: number | null; lab?: string | null } // measured USD per task; Slopalytics lab id
// RecordSchema += cost: z.number().nullable().optional(), lab: z.string().nullable().optional()
// parseProxy: cost = a positive finite number else null; lab = a non-empty string else null

// src/domain/catalog.ts
export interface Pair { /* … as today */ costUsd?: number | null; lab?: string | null }
// buildCatalog: costUsd = r.cost ?? null, lab = r.lab ?? null

// src/services/panel-catalog.ts
export const ModelPointSchema = z.object({
  effort: z.string(), rung: z.string(), intelligence: z.number(),
  usd: z.number().nullable(),   // measured cost per task, else taskUsd(price, effort), else null
  measured: z.boolean(),
});
export const CatalogEntrySchema = z.object({
  id: z.string(),               // CatalogModel.id: the family id, or the listed model id
  name: z.string().nullable(),  // the shipped family's name; null for a listed-only model
  lab: z.string().nullable(),   // Slopalytics lab id of its pairs
  backends: z.array(z.string()),// every backend that offers it, in catalogQuery order
  points: z.array(ModelPointSchema), // one per effort, in EFFORT_ORDER
});
export const CatalogViewSchema = z.object({ indexedAt: z.string().nullable(), models: z.array(CatalogEntrySchema) });
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "default", "high", "xhigh", "max", "ultra"] as const;
export function catalogView(repo?: string): CatalogView;
// one entry per CatalogModel.id; a model whose every backend listing lacks it (listed === false on all) is left out

// src/entry/panel/openapi.ts — OperationId += "getCatalog"
{ id: "getCatalog", method: "GET", path: "/api/catalog", query: SetupQuerySchema, response: CatalogViewSchema }
// SCHEMAS += CatalogView, CatalogEntry, ModelPoint; server.ts HANDLERS: getCatalog: (c) => catalogView(repoOf(c) ?? undefined)

// web/src/lib/model-name.ts
/** A model as people say it, from a model id, a provider path or a rung: `openscale/deepseek/deepseek-v4.1-flash`
 * is "DeepSeek V4.1 Flash", `codex:gpt-6-luna#high` "GPT-6 Luna", `claude-sonnet-4-5-20250929` "Claude Sonnet 4.5". */
export function modelName(idOrRung: string): string;

// web/src/lib/brand.ts
export const BRANDS = ["anthropic", "openai", "google", "xai", "deepseek", "meta", "alibaba", "mistral", "kimi", "zai",
  "opencode", "cursor", "other"] as const;
export type Brand = (typeof BRANDS)[number];
/** A backend id or rung, a backend's display name, a Slopalytics lab id, a model id or path → its brand. */
export function brandOf(key: string | null | undefined): Brand;
export const brandFill = (b: Brand): string => `var(--brand-${b})`;
export const BRAND_BG: Record<Brand, string>;   // literal "bg-brand-<b>" per brand (Tailwind must see each)
export const BRAND_TEXT: Record<Brand, string>; // literal "text-brand-<b>"

// web/src/routes/_app/runs/-lib/node-view.ts
export function nodeSecs(n: RunNode, nowMs: number): number | null;
// check node: the newest attempt's own span (its secs, else endedAt − at); any node with no dispatch attempt whose
// span is 0 → null (one event, no recorded duration); otherwise as today

// web/src/routes/_app/runs/-components/graph/RunGraph.tsx
export const ZOOM = { min: 0.25, max: 2, step: 1.25 } as const;
export function RunGraph(p: { model; milestones; selected; now; onOpen; onExpand?: () => void; fill?: boolean }): JSX.Element;

// web/src/routes/_app/models/-lib/series.ts
export interface Series { id: string; name: string; brand: Brand; dash: string;
  points: { effort: string; usd: number; intelligence: number; measured: boolean }[] }
export function seriesOf(models: CatalogEntry[], hidden: ReadonlySet<string>, scale: "log" | "linear"):
  { series: Series[]; dropped: number }; // a point with no cost (or cost ≤ 0 on log) is left out and counted
export function logTicks(min: number, max: number): number[]; // powers of ten covering [min, max]
```

## Decisions

- D1 — the log is reversed at render, after the search filter; state, paging and the live tail stay ascending — rejected: reversing state — `mergeTranscript`'s in-place replace and `at`/`next` bookkeeping assume ascending order.
- D2 — a card's key is `<line>:<n>` (n = its place among the cards of that line, counted in ascending order) and a raw line's key its original index — rejected: the array index — a reversed list shifts every index on each append, remounting cards and closing open "Thinking" blocks.
- D3 — a log longer than one page is read to its end in 500-line pages before it is drawn, newest first, and "Load more" goes — rejected: a server-side tail option — it changes `StreamQuerySchema`, src/services/transcript.ts and the client for a log that is rarely over a few thousand lines; the cost is one whole-file read per page (`// shortcut: reads every page before drawing, add a tail query past ~20k lines`).
- D4 — zoom is a controlled viewport (`viewport={{ x: PAD·z, y: PAD·z, zoom: z }}`, `minZoom={ZOOM.min} maxZoom={ZOOM.max}`) with the svg sizer scaled by z, inside the existing native-scroll frame; buttons only, gestures stay off — rejected: React Flow's `<Controls/>` and `fitView` — they fight the native-scroll sizing and bring their own look.
- D5 — the toolbar (Zoom out, Zoom in, Fit to view, Full screen) sits inside RunGraph, absolute at the frame's top right, outside the scroller — rejected: the Tile aside — it would lift zoom state into $runId.tsx and the aside already holds the step count.
- D6 — full screen is a HeroUI `Modal.Container size="full"` holding a second `RunGraph fill`; the inline graph unmounts while it is open (one React Flow at a time); while it is open the page renders `NodeDrawer` inside the modal's dialog, so the drawer is a nested overlay above it — rejected: the browser Fullscreen API — the drawer portals to `document.body` and would be hidden; rejected: one drawer at page level — the modal's focus containment hides overlays rendered outside it.
- D7 — a step with no dispatch attempt and a 0 s span shows no duration, and a check shows its newest run's own span — rejected: always hiding check durations — once plan 40 records a check's start (M34) the card shows the real time with no web change.
- D8 — one `modelName` in web/src/lib/model-name.ts; node-view.ts, -dashboard/format.ts and setup/-lib/rung.ts re-export it (`export { modelName } from …`) so their ten callers stay as they are; a dated 6+-digit part is dropped everywhere, so rung.test.ts's "Claude Haiku 4.5 20251001" becomes "Claude Haiku 4.5"; `deepseek` reads "DeepSeek", `gpt` and `glm` upper case — rejected: editing every caller — ten files for no behaviour.
- D9 — measured cost per task travels SlopRecord.cost → Pair.costUsd → the catalog view; a pair with none falls back to `taskUsd(price, effort)` with `measured: false`, and one with no price has `usd: null` — rejected: `Cost.value` — it is billing-adjusted (plan weights), not comparable across vendors. The new fields are optional, so old cached and run-pinned index files parse; the next hourly refresh (or `catherd catalog sync --force`) fills them.
- D10 — `IndexedPair`, `catalogQuery` and the Setup schemas stay unchanged; the catalog view is a new service `src/services/panel-catalog.ts` that groups `catalogQuery` rows by `id` and reads cost and lab through `pairOf` — rejected: adding fields to `IndexedPair` — it changes `catherd catalog list --json`, the Setup client type and their test fixtures for a field only the Models page reads.
- D11 — "available to us" = a model at least one backend offers or has not listed yet (`listed !== false`); every available model starts switched on; the switches are page state, not saved — rejected: saving the selection — the page is display only.
- D12 — the Models page plots one line per model, one dot per effort in EFFORT_ORDER; x is cost per task in USD on a log axis by default (Linear/Log toggle), y the intelligence index; a measured dot is filled, an estimated dot hollow; a point with no cost (or ≤ 0 on log) is left out and the page says how many — rejected: plotting estimates as measured — the estimate diverges from measurement by up to 2.6×.
- D13 — a line's colour is its lab's brand; lines of one lab vary by dash (solid, `6 3`, `2 3`, `8 3 2 3`, in list order) and every line is named in the list and the tooltip — rejected: colour alone — several labs share blues or greys.
- D14 — brand colours live only in theme.css (`--brand-<b>` in light and dark, `--color-brand-<b>` aliases) and web/src/lib/brand.ts; they colour the dashboard's backend series (backendTone), the Models page lines, swatches and the marks in its list; never a status (StatusChip, node frames, glyphs, edges, the Live dot) and never a graph frame or stroke on the run page — rejected: tinting the marks on the run graph — a coral Claude mark next to a red failed frame reads as an error. `--chart-1..5` stay for non-brand charts.
- D15 — brand values, OKLCH, light / dark. Anthropic and DeepSeek are the owner's (certain); every other row: verify against the official brand kit. Light values keep ≥ 3:1 against `oklch(1 0 0)`, dark ones against `oklch(0.185 0.004 250)` (a test asserts it):

  | brand | source | light | dark |
  | --- | --- | --- | --- |
  | anthropic (Claude, Claude Code) | #D97757 (certain) | oklch(0.6 0.13 39) | oklch(0.672 0.131 39) (= #D97757) |
  | deepseek | #4D6BFE (certain) | oklch(0.592 0.22 270) (= #4D6BFE) | oklch(0.68 0.18 270) |
  | openai (Codex) | black / white mark — verify | oklch(0.28 0 0) | oklch(0.93 0 0) |
  | google (Gemini) | Gemini violet #9B72CB — verify | oklch(0.56 0.14 305) | oklch(0.7 0.13 305) |
  | xai (Grok) | black / white — verify | oklch(0.5 0 0) | oklch(0.75 0 0) |
  | meta | #0866FF — verify | oklch(0.5 0.2 255) | oklch(0.78 0.12 245) |
  | alibaba (Qwen) | #615CED — verify | oklch(0.55 0.2 290) | oklch(0.7 0.15 290) |
  | mistral | #FA520F — verify | oklch(0.6 0.19 50) | oklch(0.74 0.16 55) |
  | kimi (Moonshot) | #1783FF — verify | oklch(0.55 0.15 245) | oklch(0.72 0.12 225) |
  | zai (GLM) | dark navy — verify | oklch(0.45 0.08 250) | oklch(0.74 0.06 200) |
  | opencode | monochrome #211E1E / #CFCECD — verify | oklch(0.55 0.05 70) | oklch(0.8 0.04 75) |
  | cursor | monochrome — verify | oklch(0.5 0.08 275) | oklch(0.72 0.08 275) |
  | other | neutral | oklch(0.58 0.01 250) | oklch(0.66 0.01 250) |
- D16 — test/fixtures/slopalytics.json gains a `"cost"` line inside the existing gpt-6-sol and claude-opus-5-5 records only (values from the proxy: gpt-6-sol none 0.33365590023828273, low 0.1327768361714764, medium 0.24728577052042386, high 0.3728406839161857, xhigh 0.5208098524368193, max 1.0446616686054255; claude-opus-5-5 low 0.551180473909146, medium 1.3360093438976588, high 1.822504718771704, xhigh 3.459110175822289, max 5.982012019521066), each right after that record's `"intelligence"` line; no record is added, removed or reordered — rejected: a second fixture — the e2e server and `withHome()` seed this one, so the Models page shows measured and estimated dots with no new seeding; intelligence is untouched, so every bar stays.
- D17 — M34 reads the start of a check from the field plan 40 adds to `check.ran` (read its schema in src/domain/run-events.ts: a start time, or a duration in ms subtracted from `at`); an event without it stays one instant — rejected: estimating the start from the previous `dispatch.ended` — it counts the heavy-lock wait as check time.
- D18 — the How-to-review paragraph lands in CONTRIBUTING.md in M30, the first milestone with a ui lane — rejected: only this plan's preamble — the ui-reviewer's brief says "the repo's docs say how" and never shows the plan.

## M30 — The run page: newest-first log, a zoomable graph, honest durations, one model name

A1 — the Log tab lists entries newest first, also for a log over 500 lines; a live line appears at the top without closing an open "Thinking" block; search still filters.
A2 — the Steps graph has Zoom out, Zoom in, Fit to view and Full screen buttons; zoom stops at 25 % and 200 %; full screen fills the viewport, a node clicked there opens its drawer above it, Escape closes the drawer first.
A3 — a fast check (or any event-only step) that ran once shows no "0s"; a check that ran several times shows its newest run's time.
A4 — every model label reads the model's name without its provider path (`openscale/deepseek/deepseek-v4.1-flash` → "DeepSeek V4.1 Flash"), from one helper.
A5 — CONTRIBUTING.md says how to open an authenticated panel on the seeded e2e server for a screen review.
A6 — the web gate, the build and the panel e2e pass; each fix has a test that fails without it.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run format:check && (cd web && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test) && (cd web && catherd lock -- bun run build && catherd lock -- bun run e2e)

### Task 201: The log, newest first

Files: web/src/routes/_app/runs/-components/transcript/TranscriptCards.tsx, web/src/routes/_app/runs/-components/transcript/TranscriptView.tsx, web/src/routes/_app/runs/-components/transcript/TranscriptCards.test.tsx, web/src/routes/_app/runs/-components/transcript/TranscriptView.test.tsx

```ts
// TranscriptCards: props unchanged; draws filter(keep) then toReversed(); keys per D2
// TranscriptView: useStreamPages reads on while a full page came back, live or not (D3); no "Load more";
// the list is drawn once the last page is in (`loaded && !more`) or a page failed, "Reading the log…" until then
```

Test: TranscriptCards.test.tsx — "cards are drawn newest first, after the search" — four cards → the first `li[data-kind]` holds the last card; with a query, the matching cards in reverse order.
Test: TranscriptCards.test.tsx — "raw lines are drawn newest first".
Test: TranscriptCards.test.tsx — "an open Thinking block stays open when a newer card arrives" — open the `<details>`, rerender with one more card appended → the same `<details>` element is still open.
Test: TranscriptView.test.tsx — "a log longer than a page is read to its end and shows its newest entry first" (replaces "a full page offers Load more…") — pages `from=0` → next 500, `from=500` → next 501; requests `from=0` then `from=500`; the first card is "second page"; no "Load more" button.
Test: TranscriptView.test.tsx — the live-tail test keeps passing (one request while live, one last read after it ends).

### Task 202: Zoom and fit

Files: web/src/routes/_app/runs/-components/graph/RunGraph.tsx, web/src/routes/_app/runs/-route.test.tsx

```ts
export const ZOOM = { min: 0.25, max: 2, step: 1.25 } as const;
// zoom state in RunGraph (default 1); viewport/minZoom/maxZoom per D4; svg sizer width={w * zoom} height={h * zoom};
// scrollToActive multiplies by zoom; a zoom change keeps the point at the frame's centre in place;
// Fit = clamp(min(frame.clientWidth / w, frame.clientHeight / h, 1), ZOOM.min, ZOOM.max)
// toolbar: role="toolbar" aria-label="Graph view"; Button isIconOnly size="sm" variant="secondary":
// "Zoom out" (MagnifierMinus), "Zoom in" (MagnifierPlus), "Fit to view" (Frame), "Full screen" (ArrowsExpand, only with onExpand);
// isDisabled at the limits; an <output> with the zoom as a percentage ("100%")
```

Test: -route.test.tsx — "Zoom in and Zoom out scale the graph and stop at the limits" — the sizer svg's `width` grows by 1.25× on Zoom in; Zoom out until disabled leaves the percentage at "25%"; Zoom in until disabled "200%".
Test: -route.test.tsx — "Fit to view never zooms past 100%" — with jsdom's zero frame size the zoom becomes 25 % (clamped), and the existing graph tests still pass.

### Task 203: Full screen

Files: web/src/routes/_app/runs/$runId.tsx, web/src/routes/_app/runs/-components/graph/RunGraph.tsx, web/src/routes/_app/runs/-route.test.tsx

```tsx
// $runId.tsx: const [full, setFull] = useState(false)
// inline: full ? <p className="text-muted …">The graph is open in full screen.</p> : <RunGraph … onExpand={() => setFull(true)} />
// <Modal.Backdrop isOpen={full} onOpenChange={setFull}><Modal.Container size="full"><Modal.Dialog aria-label="Steps of the run">
//   <Modal.Header><Modal.Heading>Steps</Modal.Heading> {stepsAside}</Modal.Header><Modal.CloseTrigger />
//   <Modal.Body><RunGraph … fill /></Modal.Body>{full ? drawer : null}</Modal.Dialog></Modal.Container></Modal.Backdrop>
// page level: {full ? null : drawer}  (drawer = the existing LiveLogContext + NodeDrawer element, D6)
// RunGraph fill: the frame is h-full with no max-h; no Full screen button
```

Test: -route.test.tsx — "Full screen shows one graph in a dialog and closes back to the page" — after "Full screen" a dialog named "Steps of the run" holds the only "Graph of the run"; the close button returns the inline graph.
Test: -route.test.tsx — "a node opened in full screen opens its drawer above it, and Escape closes the drawer first" — click a node inside the dialog → the search has `node=`, the drawer dialog is visible; Escape → the drawer is gone, the full-screen dialog stays; Escape → it closes.

### Task 204: No 0 s for a step that is one event

Files: web/src/routes/_app/runs/-lib/node-view.ts, web/src/routes/_app/runs/-lib/node-view.test.ts

```ts
export function nodeSecs(n: RunNode, nowMs: number): number | null; // Contracts
```

Test: node-view.test.ts — "a check that ran once shows no duration" — one `kind: "check"` attempt with `at === endedAt` → null.
Test: node-view.test.ts — "a check shows its newest run's own time, not first to last" — newest attempt `at` T, `endedAt` T+18 s; an older one 20 min earlier → 18.
Test: node-view.test.ts — "a commit made by one event shows no duration, a dispatch node keeps its span" — commit node with one event attempt → null; a lane node with a dispatch attempt of 0 s → 0.

### Task 205: One model name

Files: web/src/lib/model-name.ts, web/src/lib/model-name.test.ts, web/src/routes/_app/runs/-lib/node-view.ts, web/src/routes/_app/-dashboard/format.ts, web/src/routes/_app/-dashboard/format.test.ts, web/src/routes/_app/setup/-lib/rung.ts, web/src/routes/_app/setup/-lib/rung.test.ts

```ts
export function modelName(idOrRung: string): string;
// strip a leading `<backend>:` (only when it comes before any "/"), a trailing `#effort`, keep the last "/" segment;
// split on - and _; drop parts of 6+ digits; a number after a part ending in a digit joins with "." ("5-5" → 5.5);
// a number after GPT/GLM joins with "-"; words: deepseek → DeepSeek, gpt → GPT, glm → GLM, else capitalised;
// empty result → the input
// node-view.ts, -dashboard/format.ts, setup/-lib/rung.ts: their modelName becomes `export { modelName } from "<lib>/model-name"` (D8)
```

Test: model-name.test.ts — "a provider path reads as the model" — `openscale/deepseek/deepseek-v4.1-flash` → "DeepSeek V4.1 Flash"; `opencode-go:moonshot/kimi-k2` → "Kimi K2".
Test: model-name.test.ts — "every form the three old copies read" — `codex:gpt-6-luna#high` "GPT-6 Luna", `claude-opus-5-5` "Claude Opus 5.5", `gpt-6.1-sol` "GPT-6.1 Sol", `claude-sonnet-4-5-20250929` "Claude Sonnet 4.5", `gemini-3.8-flash` "Gemini 3.8 Flash", `glm-4.6` "GLM-4.6", `other` "Other".
Test: rung.test.ts — the Haiku case expects "Claude Haiku 4.5" (D8); node-view.test.ts and format.test.ts keep their cases.

### Task 206: How to review the panel's screens

Files: CONTRIBUTING.md

Under "The panel", a paragraph "Reviewing the screens": the UI-review text of this plan's preamble (build once under `catherd lock`, the e2e server in the background on `43<NN>`, the login link with `redirect` and `#token=e2e-token`, the state file's `fixture.id` and `live.id`, the Theme menu, the two viewports, stop the server), plus which seeded pages show what: `/`, `/runs/<fixture.id>` (checks, commits, a review, the drawer), `/runs/<live.id>` (a running worker and its Log tab), `/models` (once M33 lands), `/setup`.

Test: none (prose) — the lane's check asserts the paragraph names the token and the state file.

### M30 lanes

- M30.L1 — Task 201 — kind ui, difficulty build — owns web/src/routes/_app/runs/-components/transcript/TranscriptCards.tsx, web/src/routes/_app/runs/-components/transcript/TranscriptView.tsx, web/src/routes/_app/runs/-components/transcript/TranscriptCards.test.tsx, web/src/routes/_app/runs/-components/transcript/TranscriptView.test.tsx — fast check: `(cd web && bun run test src/routes/_app/runs/-components/transcript && bun run typecheck && bun run lint)`
- M30.L2 — Tasks 202, 203 — kind ui, difficulty logic — owns web/src/routes/_app/runs/-components/graph/RunGraph.tsx, web/src/routes/_app/runs/$runId.tsx, web/src/routes/_app/runs/-route.test.tsx — fast check: `(cd web && bun run test src/routes/_app/runs/-route.test.tsx && bun run typecheck && bun run lint)`
- M30.L3 — Tasks 204, 205 — kind ui, difficulty build — owns web/src/routes/_app/runs/-lib/node-view.ts, web/src/routes/_app/runs/-lib/node-view.test.ts, web/src/lib/model-name.ts, web/src/lib/model-name.test.ts, web/src/routes/_app/-dashboard/format.ts, web/src/routes/_app/-dashboard/format.test.ts, web/src/routes/_app/setup/-lib/rung.ts, web/src/routes/_app/setup/-lib/rung.test.ts — fast check: `(cd web && bun run test src/routes/_app/runs/-lib/node-view.test.ts src/lib/model-name.test.ts src/routes/_app/-dashboard/format.test.ts src/routes/_app/setup/-lib/rung.test.ts && bun run typecheck && bun run lint)`
- M30.L4 — Task 206 — kind prose, difficulty copy — owns CONTRIBUTING.md — fast check: `grep -q "e2e-token" CONTRIBUTING.md && grep -q "review-state.json" CONTRIBUTING.md && bun run format:check`

## M31 — The catalog API with measured cost

A1 — `GET /api/catalog` (operation `getCatalog`, `repo` as Setup takes it) answers one entry per available model with a point per effort: intelligence, cost per task in USD (Slopalytics' measured cost, else catherd's list-price estimate marked `measured: false`), the model's lab and the backends that offer it.
A2 — the Slopalytics index keeps each record's measured `cost` and `lab`; an index file without them still parses; routing, bars and `catherd catalog list` output are unchanged.
A3 — web/openapi.json and web/src/client/ are regenerated and match src/entry/panel/openapi.ts.
A4 — the root gate and the web gate pass; each change has a test that fails without it.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test && bun run panel:openapi && (cd web && bun install --frozen-lockfile && bun run gen) && git diff --exit-code web/openapi.json web/src/client && (cd web && bun run typecheck && bun run lint && bun run format:check && bun run test)

### Task 207: Measured cost and lab on the index

Files: src/domain/slopalytics.ts, src/domain/catalog.ts, test/domain/slopalytics.test.ts, test/domain/catalog.test.ts, test/fixtures/slopalytics.json

```ts
export interface SlopRecord { /* … */ cost?: number | null; lab?: string | null }
export interface Pair { /* … */ costUsd?: number | null; lab?: string | null }
```

The fixture edit is D16, exactly.

Test: test/domain/slopalytics.test.ts — "parseProxy keeps the measured cost and the lab" — from slopalytics-proxy.json: gpt-6-sol#high `cost` 0.3728406839161857 and `lab` "openai"; gemini-3-8-flash#low `cost` null; the existing key list gains `cost` and `lab`.
Test: test/domain/slopalytics.test.ts — "a cost that is not a positive number is missing" — `cost: 0`, `-1`, `"abc"` → null.
Test: test/domain/catalog.test.ts — "a pair carries the index's measured cost and lab" — `indexOf({ "gpt-6-sol#high": { intelligence: 42, cost: 0.37, lab: "openai" } })` → `pairOf(c, "codex:gpt-6-sol#high")` has `costUsd` 0.37 and `lab` "openai"; a record without them → `costUsd` null.
Test: test/domain/catalog.test.ts — "an index file without cost parses" — `IndexFileSchema.parse` of a record with only the seven old fields succeeds.

### Task 208: The catalog view and GET /api/catalog

Files: src/services/panel-catalog.ts, test/services/panel-catalog.test.ts, src/entry/panel/openapi.ts, src/entry/panel/server.ts, test/entry/panel-server.test.ts, web/openapi.json, web/src/client/

```ts
export function catalogView(repo?: string): CatalogView; // Contracts; loadCatalog({ repo }) once, catalogQuery({ limit: 10_000, repo })
```

Then `bun run panel:openapi && (cd web && bun run gen)`.

Test: test/services/panel-catalog.test.ts (`withHome()`) — "one entry per model, every backend that offers it" — claude-opus-5-5 appears once with `claude` and `claude-code` among its backends.
Test: test/services/panel-catalog.test.ts — "points follow effort order and carry measured cost" — gpt-6-sol points' efforts in EFFORT_ORDER; `high` has `usd` 0.3728406839161857 and `measured: true`.
Test: test/services/panel-catalog.test.ts — "a pair with no measured cost is estimated from its list price" — gemini-3-8-flash `low`: `usd === taskUsd(price, "low")`, `measured: false`.
Test: test/services/panel-catalog.test.ts — "a model no backend offers is left out" — `writeDiscovery("cursor", [{ id: "another-model", efforts: ["high"], context: null, imageIn: false }])` → no `grok-4-7` entry (cursor is its only backend and its listing lacks it); `gpt-6-sol` stays (codex and opencode have no listing).
Test: test/entry/panel-server.test.ts — "GET /api/catalog answers the catalog view" — 200, `models.length > 0`, `indexedAt` is the fixture's `fetchedAt`; `?repo=relative` → 400.

### M31 lanes

- M31.L1 — Task 207 — kind repo_code, difficulty build — owns src/domain/slopalytics.ts, src/domain/catalog.ts, test/domain/slopalytics.test.ts, test/domain/catalog.test.ts, test/fixtures/slopalytics.json — fast check: `bun test test/domain/slopalytics.test.ts test/domain/catalog.test.ts test/infra/slopalytics.test.ts test/services/catalog-service.test.ts && bun run typecheck && bun run lint`
- M31.L2 — Task 208 — after M31.L1 — kind repo_code, difficulty build — owns src/services/panel-catalog.ts, test/services/panel-catalog.test.ts, src/entry/panel/openapi.ts, src/entry/panel/server.ts, test/entry/panel-server.test.ts, web/openapi.json, web/src/client/ — fast check: `bun test test/services/panel-catalog.test.ts test/entry/panel-server.test.ts test/entry/panel-openapi.test.ts && bun run typecheck && bun run lint`

## M32 — Brand colours

After: M30

A1 — `--brand-*` variables exist for every brand in both themes, with Tailwind aliases, and one map (web/src/lib/brand.ts) turns a backend, a backend name, a lab or a model into its brand.
A2 — the dashboard's backend series use the brand colours (Claude Code and Claude the same, Codex its own); no status colour, node frame, edge or glyph uses a brand variable.
A3 — every brand colour holds 3:1 contrast against the surface of its theme.
A4 — the web gate passes; each change has a test that fails without it.
A7 — the diff adds no home-directory path and no private host name.

Check: (cd web && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test)

### Task 209: Brand variables and the brand map

Files: web/src/theme.css, web/src/lib/brand.ts, web/src/lib/brand.test.ts, web/src/routes/_app/-dashboard/format.ts, web/src/routes/_app/-dashboard/format.test.ts

```ts
export function brandOf(key: string | null | undefined): Brand;
// lower case; a rung's part before ":"; claude, claude-code, "claude code" → anthropic; codex → openai;
// opencode, opencode-go → opencode; cursor → cursor; a lab id in BRANDS → itself; else the last "/" segment by
// prefix: claude → anthropic, gpt → openai, gemini → google, grok → xai, deepseek → deepseek, llama → meta,
// qwen → alibaba, mistral|devstral|codestral → mistral, kimi → kimi, glm → zai; else "other"
export function backendTone(backendOrName: string): { fill: string; bg: string }; // = { fill: brandFill(b), bg: BRAND_BG[b] }, TONE/FILL/BG go
```

theme.css: D15's values as `--brand-<b>` in the light and the dark block, a comment that they never mark a status, and `--color-brand-<b>: var(--brand-<b>)` in `@theme inline`.

Test: brand.test.ts — "every backend, backend name, lab and model maps to its brand, anything else to other" — `claude-code`, `Claude Code`, `codex:gpt-6-sol`, `opencode-go`, `deepseek`, `openscale/deepseek/deepseek-v4.1-flash`, `gemini-3-8-flash`, `glm-4.6`, `acme` → anthropic, anthropic, openai, opencode, deepseek, deepseek, google, zai, other.
Test: brand.test.ts — "every brand has a light and a dark value and an alias" — theme.css (read with `readFileSync`) holds `--brand-<b>:` twice and `--color-brand-<b>:` once per brand.
Test: brand.test.ts — "every brand colour holds 3:1 against its theme's surface" — parse each `oklch(L C H)`, convert OKLCH → OKLab → linear sRGB (clipped to [0, 1]), WCAG relative luminance, contrast against `--surface` of the same block ≥ 3.
Test: format.test.ts — "a backend keeps one colour everywhere" stays; adds `backendTone("Claude Code").fill === "var(--brand-anthropic)"`.

### M32 lanes

- M32.L1 — Task 209 — kind ui, difficulty build — owns web/src/theme.css, web/src/lib/brand.ts, web/src/lib/brand.test.ts, web/src/routes/_app/-dashboard/format.ts, web/src/routes/_app/-dashboard/format.test.ts — fast check: `(cd web && bun run test src/lib/brand.test.ts src/routes/_app/-dashboard src/conventions.test.ts && bun run typecheck && bun run lint)`

## M33 — The Models page

After: M31, M32

A1 — a "Models" page (`/models`, in the nav under Configure and in the command menu) plots cost per task (USD, Log by default, Linear/Log switch) against the intelligence index: one line per model in its lab's brand colour, one dot per effort, measured dots filled and estimated ones hollow, a tooltip naming model, effort, intelligence, cost and whether it is measured.
A2 — a side list "Available to us" names each available model with its backends' marks and a switch that hides or shows its line; display only, nothing is saved.
A3 — the page says how many points have no cost, when the index was fetched and where the numbers come from, and with nothing indexed says how to sync.
A4 — the web gate, the build and the panel e2e pass (the smoke pages include `/models`); each change has a test that fails without it.
A5 — no file under web/src/routes/_app/runs or web/src/components/status-chip uses a brand class or variable.
A7 — the diff adds no home-directory path and no private host name.

Check: (cd web && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test) && ! grep -rnE "brand-|BRAND_|brandOf" web/src/routes/_app/runs web/src/components/status-chip && bun install --frozen-lockfile && (cd web && catherd lock -- bun run build && catherd lock -- bun run e2e)

### Task 210: The page

Files: web/src/routes/_app/models/index.tsx, web/src/routes/_app/models/-components/CostChart.tsx, web/src/routes/_app/models/-components/ModelList.tsx, web/src/routes/_app/models/-lib/series.ts, web/src/routes/_app/models/-lib/series.test.ts, web/src/routes/_app/models/-route.test.tsx, web/src/routeTree.gen.ts

```ts
export const Route = createFileRoute("/_app/models/")({ component: ModelsPage });
export function seriesOf(models, hidden, scale): { series: Series[]; dropped: number }; // Contracts; name = name ?? modelName(id); brand = brandOf(lab ?? id); dash per D13
export function logTicks(min: number, max: number): number[];
export function CostChart(p: { series: Series[]; scale: "log" | "linear" }): JSX.Element;
export function ModelList(p: { models: CatalogEntry[]; hidden: ReadonlySet<string>; onToggle: (id: string) => void }): JSX.Element;
```

After the route file exists, run `(cd web && catherd lock -- bun run build)` once to regenerate routeTree.gen.ts, and commit it.

Layout and copy (exact): `PageHeader` title "Models", description "Every model catherd can route to: how it scores and what one task costs at each effort." A `lg:grid-cols-12` grid: `Tile` "Cost vs intelligence" (`lg:col-span-8`, aside a `ToggleButtonGroup aria-label="Cost axis"` with "Log" and "Linear", as DailyChart's) and `Tile` "Available to us" (`lg:col-span-4`); on phones they stack. Under the chart title: "Up and to the left is better: more intelligence for less money per task. Filled dots are measured, hollow ones estimated from list prices." The chart: recharts `LineChart` in a `ResponsiveContainer` (`initialDimension` as DailyChart), `XAxis type="number" dataKey="usd" scale={scale}` (log: `domain` and `ticks` from `logTicks`, `allowDataOverflow`; linear: `[0, "auto"]`), label "Cost per task (USD)", `YAxis` label "Intelligence index", `CartesianGrid stroke={GRID_STROKE}`, `AXIS_TICK`, one `<Line data={s.points} dataKey="intelligence" stroke={brandFill(s.brand)} strokeDasharray={s.dash} isAnimationActive={false}>` per series with a dot that is filled (`brandFill`) when measured and `var(--surface)` with a brand stroke when estimated, `Tooltip` content through `ChartTooltip` (title the model name; rows effort, intelligence, "$x per task", "measured" or "estimated"). The chart wrapper has `role="img"` and `aria-label="Cost vs intelligence of <n> models"`. Below it: "<n> points have no known cost and are not drawn." when `dropped > 0`, and "Intelligence and measured cost per task: Slopalytics (Artificial Analysis data), fetched <date>." from `indexedAt`. List rows: a brand swatch (`BRAND_BG`), the name, the marks of its backends (`ProviderIcon` with `className={BRAND_TEXT[brandOf(backend)]}`, one per distinct provider), a muted line "<k> of <n> costs estimated" or "No cost known", and a `Switch` labelled with the model's name. `DataList.State` for loading, error and empty; empty text: "No model is indexed yet. Run catherd catalog sync, then reload." Query: `getCatalogOptions()`. Colours come only from brand.ts and theme.css; no `style={}`.

Test: series.test.ts — "a model's points follow its efforts and a point with no cost is left out and counted" — two entries, one point `usd: null` → that point gone, `dropped` 1.
Test: series.test.ts — "the log scale leaves out a cost of 0, the linear scale keeps it".
Test: series.test.ts — "a hidden model has no series; models of one lab get different dashes".
Test: series.test.ts — "logTicks covers the range in powers of ten" — (0.02, 5.9) → [0.01, 0.1, 1, 10].
Test: -route.test.tsx — "the page lists the available models and plots one line each" — fake `GET /api/catalog` with three models → three switches, chart label "Cost vs intelligence of 3 models", the attribution line with the date.
Test: -route.test.tsx — "switching a model off hides its line" — the label becomes "… of 2 models"; switching it on again → 3.
Test: -route.test.tsx — "Log is the default and Linear switches the axis" — "Log" pressed at first; after "Linear" it is.
Test: -route.test.tsx — "a model with estimated costs says so" — "2 of 5 costs estimated".
Test: -route.test.tsx — "with nothing indexed the page says how to sync" — `models: []` → the empty text.

### Task 211: Nav and command menu

Files: web/src/routes/_app/-components/Shell.tsx, web/src/routes/_app/-components/Shell.test.tsx, web/src/routes/_app/-components/CommandMenu.tsx, web/e2e/smoke.spec.ts

```ts
// Shell GROUPS: Configure = [{ href: "/models", label: "Models", icon: ChartLine }, { href: "/setup", label: "Setup", icon: Gear }]
// CommandMenu PAGES += { id: "page:/models", label: "Models", href: "/models" } (before Setup)
// smoke.spec.ts pages() += ["/models", "Models"]
```

Test: Shell.test.tsx — "the nav lists Dashboard, Runs, Questions, Models and Setup, and marks the current page" — five links; `Models` current on `/models`; the custom-link test expects 5.

### M33 lanes

- M33.L1 — Task 210 — kind ui, difficulty build — owns web/src/routes/_app/models/index.tsx, web/src/routes/_app/models/-components/CostChart.tsx, web/src/routes/_app/models/-components/ModelList.tsx, web/src/routes/_app/models/-lib/series.ts, web/src/routes/_app/models/-lib/series.test.ts, web/src/routes/_app/models/-route.test.tsx, web/src/routeTree.gen.ts — fast check: `(cd web && bun run test src/routes/_app/models src/conventions.test.ts && bun run typecheck && bun run lint)`
- M33.L2 — Task 211 — kind ui, difficulty copy — owns web/src/routes/_app/-components/Shell.tsx, web/src/routes/_app/-components/Shell.test.tsx, web/src/routes/_app/-components/CommandMenu.tsx, web/e2e/smoke.spec.ts — fast check: `(cd web && bun run test src/routes/_app/-components && bun run typecheck && bun run lint)`

## M34 — A check's own run time

After: M30

A1 — once `check.ran` carries plan 40's start time or duration, the check's attempt spans that run, so the panel shows the check's real time; an older `check.ran` without it is still one instant (no "0s", from M30).
A2 — the root gate passes; each change has a test that fails without it.
A3 — the panel API document is unchanged (`bun run panel:openapi` leaves web/openapi.json as it is).
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test && bun run panel:openapi && git diff --exit-code web/openapi.json

### Task 212: The check attempt spans its run

Files: src/domain/run-graph.ts, test/domain/run-graph.test.ts

```ts
// case "check.ran": event(e, "check", label, status, { round, exit, at: <start>, secs: <seconds> })
// <start> = the event's start field, else at − its duration (D17); with neither, at = e.at and secs = null as today
```

Test: test/domain/run-graph.test.ts — "a check attempt spans the check's own run" — a `check.ran` 18 s long (in plan 40's field) → the attempt's `at` is 18 s before its `endedAt` and `secs` 18.
Test: test/domain/run-graph.test.ts — "a check.ran without a start stays one instant" — `at === endedAt`, `secs` null.

### M34 lanes

- M34.L1 — Task 212 — kind repo_code, difficulty build — owns src/domain/run-graph.ts, test/domain/run-graph.test.ts — fast check: `bun test test/domain/run-graph.test.ts test/services/run-model.test.ts && bun run typecheck && bun run lint`

## M35 — Changeset

After: M30, M31, M32, M33, M34

A1 — a `catherd-cli` minor changeset names the user-visible changes: newest-first log, graph zoom and full screen, no false 0 s durations, readable model names, the Models page, brand colours.
A2 — the root gate passes.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run format:check && bunx changeset status

### Task 213: The changeset

Files: .changeset/plan-42-panel-models.md

```md
---
"catherd-cli": minor
---

The panel: a role's log reads newest first; the run graph zooms, fits and opens full screen; a step that is one event no longer shows 0s, and a fast check shows its own time; model names drop their provider path; a new Models page plots cost per task against intelligence for every model catherd can route to; backends and labs keep their brand colours on the dashboard and the Models page.
```

Test: none (prose) — the lane's check asserts the file and its bump.

### M35 lanes

- M35.L1 — Task 213 — kind prose, difficulty copy — owns .changeset/plan-42-panel-models.md — fast check: `grep -q '"catherd-cli": minor' .changeset/plan-42-panel-models.md`

## Edge cases

- A log of exactly 500 lines: a second request answers 0 lines, then the list is drawn.
- A log page that fails mid-way: the error shows above the cards already read, newest of those first.
- A live frame that arrives while later pages are still being read: kept, as today (`held`), and drawn at the top once the list shows.
- Search with a reversed list: the count line stays above the list and counts the same entries.
- Two cards from one stream line (a Claude message with two tool calls): distinct keys by their place in the line.
- Zoom when the graph remounts on a shape change (`key={laid.key}`): the zoom state lives in RunGraph and survives.
- Fit on a graph smaller than the frame: never above 100 %.
- Full screen on a phone: the button exists only on the graph (desktop); the node list has none.
- Escape with the drawer open in full screen: the drawer closes first, then the dialog.
- A run that ends while full screen is open: the graph updates in place; the dialog stays until closed.
- A check node with attempts from before and after M34: the newest attempt decides.
- `modelName` of a model id with a colon after a slash (`ollama/qwen3:8b`): the colon is kept.
- An index pinned in an old run (no `cost`, no `lab`): parses; those pairs are estimated and their brand comes from the model id.
- A listed-only model (no shipped family): `name` null, the page shows `modelName(id)`.
- A model with only a `default` effort: one dot, no line segment.
- Every point of a model without cost: no line, its row says "No cost known", its switch still works.
- A cost of 0 on the log axis: left out and counted; on linear it is drawn at 0.
- `indexedAt` null: the attribution line says "not fetched yet".
- A lab Slopalytics adds later: brand "other" until brand.ts names it.

## Out of scope

- The orchestration core and the `check.ran` event itself (plan 40: src/domain/run-events.ts, run-state.ts, run-machine.ts, run-effects.ts and their tests).
- Cheap-tier routing, the opencode adapter and its transcript parser (plan 41: src/adapters/opencode/*, src/services/transcript.ts and test/services/transcript.test.ts).
- A server-side tail for long logs (D3), a saved model selection (D11), React Flow's own controls or a minimap, pinch or wheel zoom.
- Brand colours on the run graph, StatusChip, node frames, edges or any status (D14); tinting marks outside the Models page.
- Any redesign of the dashboard, Setup, Questions or the run page beyond these items; routing, bars and `catherd catalog list` output.
