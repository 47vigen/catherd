import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { getSetupQueryKey } from "../../../client/@tanstack/react-query.gen";
import { client } from "../../../client/client.gen";
import { describeRequest, renderRoute } from "../../../test/render-route";

afterEach(() => client.setConfig({ baseUrl: "", fetch: undefined }));

const pair = (rung: string, intelligence: number, over: object = {}) => ({
  rung,
  intelligence,
  price: { input: 1.25, output: 10 },
  speed: 80,
  context: null,
  cost: { tier: 0, value: 0, mode: "chatgpt-plan" },
  evidence: null,
  newer: null,
  ...over,
});
const LUNA = "codex:gpt-6-luna#high";
const SOL = "codex:gpt-6-sol#high";
const XHIGH = "codex:gpt-6-sol#xhigh";
const OPUS = "claude-code:claude-opus-5-5#high";

const role = (name: string, over: object = {}) => ({
  role: name,
  enabled: true,
  access: "workspace-write",
  network: true,
  timeouts: null,
  hostSet: false,
  rungs: [],
  offered: [],
  ...over,
});

const setup = (over: object = {}) => ({
  repo: "/work/wallet",
  host: "codex",
  repos: [{ path: "/work/wallet", profile: "default" }],
  profile: {
    name: "default",
    active: "default",
    profiles: ["default", "fast"],
    bindings: { "/work/wallet": "default" },
  },
  probedAt: new Date(Date.now() - 180_000).toISOString(),
  pending: false,
  settings: {
    budget: { usd: 5 },
    timeouts: { idleMin: 15, wallMin: 90 },
    failover: { [SOL]: LUNA },
    maxEffort: { "codex:gpt-6-sol": "high" },
    heavy: "cpus/2",
    memory: { reserveMb: 2048, perMilestoneMb: 1024, floorMb: 512 },
    preflightConfirm: false,
    landAutoMerge: false,
    notify: ["milestone", "finish", "blocked"],
    billing: { codex: "chatgpt-plan", opencode: "metered" },
    isolated: { codex: false },
  },
  notifyUrl: null,
  doc: {},
  catalog: { id: "catalog", label: "catalog", state: "ok", word: "fresh", detail: "checked 3 min ago" },
  backends: [
    {
      id: "backend:codex",
      label: "codex",
      state: "fail",
      word: "missing",
      detail: "not installed",
      fix: "npm i -g @openai/codex",
    },
    { id: "backend:opencode", label: "opencode", state: "ok", word: "ready", detail: "1.2.3" },
  ],
  issues: {
    errors: [{ path: "roles.worker.rungs", message: "no usable rung", fix: "catherd profile set roles.worker.rungs" }],
    warnings: [
      { path: "budget.usd", message: "no budget is set" },
      { path: "roles.worker.access", message: "worker runs with full access" },
      { path: "roles.reviewer.access", message: "reviewer runs with full access" },
    ],
  },
  roles: [
    role("worker", {
      rungs: [
        { rung: LUNA, intelligence: 40.2 },
        { rung: SOL, intelligence: 50 },
      ],
      offered: [pair(XHIGH, 55), pair(SOL, 50), pair(LUNA, 40.2), pair(OPUS, 60)],
    }),
    role("reviewer", {
      rungs: [{ rung: SOL, intelligence: 50 }],
      offered: [pair(SOL, 50), pair(XHIGH, 55)],
    }),
    role("artist", { enabled: false }),
    role("architect", { hostSet: true, offered: [pair(SOL, 50)] }),
  ],
  ...over,
});

const preview = (over: object = {}) => ({
  saved: false,
  errors: [],
  warnings: [],
  diff: [{ path: "budget.usd", before: 5, after: 8 }],
  linked: [],
  pruned: [],
  newSessionNeededFor: [],
  expect: { name: "default", budget: { usd: 5 } },
  wouldSave: true,
  added: [],
  ...over,
});
const saved = (over: object = {}) => ({
  saved: true,
  errors: [],
  warnings: [],
  diff: [],
  linked: [],
  pruned: [],
  newSessionNeededFor: [],
  ...over,
});

type Handlers = Record<string, (req: Request) => Response>;
const api =
  (handlers: Handlers = {}, view: object = setup()) =>
  (req: Request, url: URL) => {
    const key = `${req.method} ${url.pathname}`;
    if (key === "GET /api/setup") return Response.json(view);
    if (key === "POST /api/setup/recheck") return Response.json(view);
    return handlers[key]?.(req);
  };

const section = (name: string) => screen.getByRole("region", { name });
const roleLine = (name: string) => screen.getByRole("listitem", { name });

/** Opens the folded settings tile. */
async function openSettings() {
  await userEvent.click(await screen.findByRole("button", { name: /Change settings/ }));
}

/** Opens a role's drawer from its line in the overview and returns the drawer. */
async function openRole(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Edit ${name}` }));
  return screen.findByRole("dialog", { name: name.charAt(0).toUpperCase() + name.slice(1) });
}

/** Picks an action from a model's menu in the open drawer. */
async function modelAction(drawer: HTMLElement, rung: string, action: string) {
  await userEvent.click(within(drawer).getByRole("button", { name: `More for ${rung}` }));
  await userEvent.click(await screen.findByRole("menuitem", { name: action }));
}
const count = (requests: Request[], what: string) => requests.filter((r) => describeRequest(r).startsWith(what)).length;
const searchOf = (r: Request) => new URL(r.url).searchParams.get("repo");

async function editBudgetUsd(value: string) {
  await openSettings();
  const budget = await screen.findByRole("region", { name: "Budget" });
  const usd = within(budget).getByLabelText("USD");
  await userEvent.clear(usd);
  await userEvent.type(usd, value);
  await userEvent.click(within(budget).getByRole("button", { name: "Review changes" }));
}

test("shows every role on one line with its models in the order tried, and the backends", async () => {
  renderRoute("/setup", api());
  expect(await screen.findByText("not installed")).toBeInTheDocument();
  expect(screen.getByText("1.2.3")).toBeInTheDocument();
  expect(screen.getByText(/· this repo/)).toBeInTheDocument();
  expect(screen.getByText(/budget\.usd: no budget is set/)).toBeInTheDocument();
  const worker = roleLine("worker");
  const chain = within(worker).getByRole("list", { name: "worker models, in the order tried" });
  expect(
    within(chain)
      .getAllByRole("listitem")
      .slice(0, 2)
      .map((s) => s.textContent),
  ).toEqual([expect.stringContaining("GPT-6 Luna"), expect.stringContaining("GPT-6 Sol")]);
  expect(within(worker).getByText(/1 problem/)).toBeInTheDocument();
  expect(within(worker).queryByText("40.2")).not.toBeInTheDocument();
  expect(within(roleLine("architect")).getByText("Picked by the app that runs catherd")).toBeInTheDocument();
  expect(screen.getByText("Checked 3m ago")).toBeInTheDocument();
});

test("the folded settings say who merges a landed milestone", async () => {
  const land = async () => (await screen.findByText("Land", { selector: "dt" })).parentElement;
  const { unmount } = renderRoute("/setup", api());
  expect(await land()).toHaveTextContent("Owner");
  unmount();
  renderRoute("/setup", api({}, setup({ settings: { ...setup().settings, landAutoMerge: true } })));
  expect(await land()).toHaveTextContent("catherd");
});

test("a role's drawer lists its models in the order tried, with its problems", async () => {
  renderRoute("/setup", api());
  const drawer = await openRole("worker");
  expect(within(drawer).getByText(/roles\.worker\.rungs: no usable rung/)).toBeInTheDocument();
  const steps = within(within(drawer).getByRole("grid", { name: "Worker models" })).getAllByRole("row");
  expect(steps.map((s) => s.textContent)).toEqual([
    expect.stringContaining("GPT-6 Luna"),
    expect.stringContaining("GPT-6 Sol"),
  ]);
  expect(steps[0]).toHaveTextContent("Tried first");
  expect(steps[1]).toHaveTextContent("then, if it fails");
});

test("a model's effort is changed in place and reviewed as a new rung", async () => {
  const { requests } = renderRoute("/setup", api({ "POST /api/setup/preview": () => Response.json(preview()) }));
  const drawer = await openRole("worker");
  await userEvent.click(within(drawer).getByRole("button", { name: new RegExp(`Effort for ${SOL}`) }));
  await userEvent.click(await screen.findByRole("option", { name: "xhigh" }));
  await userEvent.click(within(drawer).getByRole("button", { name: "Review changes" }));
  await waitFor(() => expect(count(requests, "POST /api/setup/preview")).toBe(1));
  expect(
    await requests
      .find((r) => describeRequest(r) === "POST /api/setup/preview")!
      .clone()
      .json(),
  ).toEqual({ patch: { roles: { worker: { rungs: [LUNA, XHIGH] } } } });
});

test("a backend that is not ready shows its fix command", async () => {
  renderRoute("/setup", api());
  expect(await screen.findByText("npm i -g @openai/codex")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
});

test("Re-check probes again", async () => {
  const { requests } = renderRoute("/setup", api());
  await userEvent.click(await screen.findByRole("button", { name: "Re-check" }));
  await waitFor(() => expect(count(requests, "POST /api/setup/recheck")).toBe(1));
});

test("a re-check that lands after the repo changed is stored under the repo it probed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { requests, router, queryClient } = renderRoute("/setup?repo=%2Fwork%2Fa", async (req, url) => {
    const repo = url.searchParams.get("repo");
    if (req.method === "GET" && url.pathname === "/api/setup") return Response.json(setup({ repo }));
    if (req.method === "POST" && url.pathname === "/api/setup/recheck") {
      await gate;
      return Response.json(setup({ repo }));
    }
  });
  await userEvent.click(await screen.findByRole("button", { name: "Re-check" }));
  await waitFor(() => expect(count(requests, "POST /api/setup/recheck")).toBe(1));
  await router.navigate({ to: "/setup", search: { repo: "/work/b" } });
  await waitFor(() => expect(requests.map(searchOf)).toContain("/work/b"));
  release();
  await waitFor(() =>
    expect(queryClient.getQueryData<{ repo: string }>(getSetupQueryKey({ query: { repo: "/work/a" } }))?.repo).toBe(
      "/work/a",
    ),
  );
  expect(queryClient.getQueryData<{ repo: string }>(getSetupQueryKey({ query: { repo: "/work/b" } }))?.repo).toBe(
    "/work/b",
  );
});

test("the repo picker sends repo to every setup call", async () => {
  const repo = "/tmp/my repo";
  const { requests } = renderRoute(
    `/setup?repo=${encodeURIComponent(repo)}`,
    api({
      "POST /api/setup/preview": () => Response.json(preview()),
      "PUT /api/setup/profile": () => Response.json(saved()),
    }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Re-check" }));
  await editBudgetUsd("8");
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() => expect(count(requests, "PUT /api/setup/profile")).toBe(1));
  for (const what of ["GET /api/setup", "POST /api/setup/recheck", "POST /api/setup/preview", "PUT /api/setup/profile"])
    expect(requests.filter((r) => describeRequest(r).startsWith(what)).map(searchOf), what).toEqual(
      expect.arrayContaining([repo]),
    );
  expect(
    requests.filter((r) => describeRequest(r).startsWith("POST /api/setup/")).every((r) => searchOf(r) === repo),
  ).toBe(true);
});

test("the repo picker offers the global default", async () => {
  const { requests } = renderRoute("/setup", api());
  await userEvent.click(await screen.findByRole("button", { name: /Repo/ }));
  await userEvent.click(await screen.findByRole("option", { name: "Global default" }));
  await waitFor(() => expect(requests.map(searchOf)).toContain("global"));
});

test("editing the budget previews before → after and saves with the previewed document", async () => {
  const { requests } = renderRoute(
    "/setup",
    api({
      "POST /api/setup/preview": () => Response.json(preview()),
      "PUT /api/setup/profile": () => Response.json(saved()),
    }),
  );
  await editBudgetUsd("8");
  const dialog = await screen.findByRole("dialog", { name: "Review changes" });
  expect(within(dialog).getByText("budget.usd").closest("li")).toHaveTextContent("Before5After8");
  const sent = await requests
    .find((r) => describeRequest(r) === "POST /api/setup/preview")!
    .clone()
    .json();
  expect(sent).toEqual({ patch: { budget: { usd: 8 } } });
  const before = count(requests, "GET /api/setup");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  const put = await waitFor(() => requests.find((r) => describeRequest(r) === "PUT /api/setup/profile")!);
  expect(await put.clone().json()).toEqual({
    patch: { budget: { usd: 8 } },
    expect: { name: "default", budget: { usd: 5 } },
  });
  expect(await screen.findByText("Saved.")).toBeInTheDocument();
  await waitFor(() => expect(count(requests, "GET /api/setup")).toBeGreaterThan(before));
});

test("settings show no decision model", async () => {
  renderRoute("/setup", api({}));
  await openSettings();
  for (const gone of [/Objective/, /Jev/, /Difficulty bars/, /Decision model/])
    expect(screen.queryByRole("heading", { name: gone })).not.toBeInTheDocument();
});

test("clearing the budget field sends null for it", async () => {
  const { requests } = renderRoute("/setup", api({ "POST /api/setup/preview": () => Response.json(preview()) }));
  await openSettings();
  const budget = await screen.findByRole("region", { name: "Budget" });
  await userEvent.clear(within(budget).getByLabelText("USD"));
  await userEvent.click(within(budget).getByRole("button", { name: "Review changes" }));
  const sent = await requests
    .find((r) => describeRequest(r) === "POST /api/setup/preview")!
    .clone()
    .json();
  expect(sent).toEqual({ patch: { budget: { usd: null } } });
});

test("an invalid number is flagged and cannot be reviewed", async () => {
  renderRoute("/setup", api());
  await openSettings();
  const budget = await screen.findByRole("region", { name: "Budget" });
  await userEvent.type(within(budget).getByLabelText("Minutes"), "abc");
  expect(within(budget).getByText("Enter a number above zero, or leave empty.")).toBeInTheDocument();
  expect(within(budget).getByRole("button", { name: "Review changes" })).toBeDisabled();
});

test("a refused save shows its errors inline", async () => {
  renderRoute(
    "/setup",
    api({
      "POST /api/setup/preview": () => Response.json(preview()),
      "PUT /api/setup/profile": () =>
        Response.json(
          saved({
            saved: false,
            errors: [
              { path: "budget.usd", message: "usd must be a positive number" },
              { path: "budget.tokens", message: "a second problem", fix: "catherd profile show" },
            ],
          }),
        ),
    }),
  );
  await editBudgetUsd("8");
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByText(/usd must be a positive number/)).toBeInTheDocument();
  expect(screen.getByText(/a second problem \(catherd profile show\)/)).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Review changes" })).toBeInTheDocument();
});

test("a preview with errors cannot be saved", async () => {
  const low = { path: "budget.usd", message: "too low" };
  renderRoute(
    "/setup",
    api({
      "POST /api/setup/preview": () => Response.json(preview({ errors: [low], added: [low], wouldSave: false })),
    }),
  );
  await editBudgetUsd("8");
  expect(await screen.findByText(/budget\.usd: too low/)).toBeInTheDocument();
  expect(screen.getByText("Not saved")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("a repair the server would save can be saved, its leftover errors shown as already there", async () => {
  const old = { path: "failover", message: "same quota" };
  renderRoute(
    "/setup",
    api({ "POST /api/setup/preview": () => Response.json(preview({ errors: [old], added: [], wouldSave: true })) }),
  );
  await editBudgetUsd("8");
  expect(await screen.findByText(/failover: same quota/)).toBeInTheDocument();
  expect(screen.queryByText("Not saved")).toBeNull();
  expect(screen.getByText("Already wrong before this change")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("a change that repairs nothing on a broken profile says the old errors are why it is not saved", async () => {
  const old = { path: "failover", message: "same quota" };
  renderRoute(
    "/setup",
    api({ "POST /api/setup/preview": () => Response.json(preview({ errors: [old], added: [], wouldSave: false })) }),
  );
  await editBudgetUsd("8");
  expect(await screen.findByText(/failover: same quota/)).toBeInTheDocument();
  expect(screen.getByText("Not saved: this change must fix one of these first")).toBeInTheDocument();
  expect(screen.queryByText("Already wrong before this change")).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("a changed profile on disk asks to review again", async () => {
  const { requests } = renderRoute(
    "/setup",
    api({
      "POST /api/setup/preview": () => Response.json(preview()),
      "PUT /api/setup/profile": () =>
        Response.json(
          saved({
            saved: false,
            errors: [{ path: "profile", message: 'profile "default" changed on disk since it was shown' }],
          }),
        ),
    }),
  );
  await editBudgetUsd("8");
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(
    await screen.findByText("The profile changed since you opened it. Review the changes again."),
  ).toBeInTheDocument();
  await waitFor(() => expect(count(requests, "POST /api/setup/preview")).toBe(2));
});

test("the models reorder with Move up and save the new order", async () => {
  const { requests } = renderRoute(
    "/setup",
    api({
      "POST /api/setup/preview": () =>
        Response.json(preview({ diff: [{ path: "roles.worker.rungs", before: [LUNA, SOL], after: [SOL, LUNA] }] })),
      "PUT /api/setup/profile": () => Response.json(saved()),
    }),
  );
  const worker = await openRole("worker");
  await userEvent.click(within(worker).getByRole("button", { name: `More for ${LUNA}` }));
  expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");
  await modelAction(worker, SOL, "Move up");
  const steps = within(within(worker).getByRole("grid", { name: "Worker models" })).getAllByRole("row");
  expect(steps[0]).toHaveTextContent("GPT-6 Sol");
  await userEvent.click(within(worker).getByRole("button", { name: "Review changes" }));
  const sent = await requests
    .find((r) => describeRequest(r) === "POST /api/setup/preview")!
    .clone()
    .json();
  expect(sent).toEqual({ patch: { roles: { worker: { rungs: [SOL, LUNA] } } } });
  const dialog = await screen.findByRole("dialog", { name: "Review changes" });
  expect(within(dialog).getByText("roles.worker.rungs").closest("li")).toHaveTextContent(
    "Before1GPT-6 Lunahigh2GPT-6 SolhighAfter1GPT-6 Solhigh2GPT-6 Lunahigh",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(count(requests, "PUT /api/setup/profile")).toBe(1));
});

test("Remove takes a model off the list", async () => {
  renderRoute("/setup", api());
  const worker = await openRole("worker");
  await modelAction(worker, LUNA, "Remove");
  const steps = within(within(worker).getByRole("grid", { name: "Worker models" })).getAllByRole("row");
  expect(steps).toHaveLength(1);
  expect(steps[0]).toHaveTextContent("GPT-6 Sol");
  expect(within(worker).getByText("Not saved yet.")).toBeInTheDocument();
  await userEvent.click(within(worker).getByRole("button", { name: "Undo" }));
  expect(within(within(worker).getByRole("grid", { name: "Worker models" })).getAllByRole("row")).toHaveLength(2);
});

test("Add a fallback model lists models strongest first, and an effort plus Add puts it last", async () => {
  renderRoute("/setup", api());
  const worker = await openRole("worker");
  await userEvent.click(within(worker).getByRole("button", { name: "Add a fallback model" }));
  const list = await screen.findByRole("list", { name: "Models" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getAllByText(/\$1\.25\/\$10 per M · 80 tok\/s · on your plan/).length).toBeGreaterThan(0);
  expect(screen.getByRole("radiogroup", { name: "Provider" })).toBeInTheDocument();
  const add = screen.getByRole("button", { name: "Add" });
  expect(add).toBeDisabled();
  const opus = screen.getByRole("radiogroup", { name: /Claude Opus 5\.5 via Claude Code, effort/ });
  await userEvent.click(within(opus).getAllByRole("radio")[0]!);
  await userEvent.click(add);
  const steps = within(within(worker).getByRole("grid", { name: "Worker models" })).getAllByRole("row");
  expect(steps).toHaveLength(3);
  expect(steps[2]).toHaveTextContent("Claude Opus 5.5");
});

test("older versions stay out of the picker until asked for, and a rung on the role names its newer version", async () => {
  const OLD_LUNA = "codex:gpt-5.6-luna#high";
  const OLD_SOL = "codex:gpt-5.6-sol#high";
  const view = setup({
    roles: [
      role("worker", {
        rungs: [{ rung: OLD_LUNA, intelligence: 30 }],
        offered: [
          pair(SOL, 50),
          pair(OLD_SOL, 45, { newer: "GPT-6 Sol" }),
          pair(OLD_LUNA, 30, { newer: "GPT-6 Luna" }),
        ],
      }),
    ],
  });
  renderRoute("/setup", api({}, view));
  const worker = await openRole("worker");
  const steps = within(within(worker).getByRole("grid", { name: "Worker models" })).getAllByRole("row");
  expect(steps[0]).toHaveTextContent("Tried first · via Codex · Newer: GPT-6 Luna");
  await userEvent.click(within(worker).getByRole("button", { name: "Add a fallback model" }));
  const list = await screen.findByRole("list", { name: "Models" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  const older = screen.getByRole("switch", { name: "Older versions" });
  expect(older).not.toBeChecked();
  await userEvent.click(older);
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText(/Newer: GPT-6 Sol/)).toBeInTheDocument();
});

test("a role with no indexed pair says to sync the catalog", async () => {
  renderRoute("/setup", api());
  const artist = await openRole("artist");
  await userEvent.click(within(artist).getByRole("button", { name: "Add a model" }));
  expect(
    await screen.findByText("No indexed pair fits this role. Run catherd catalog sync, then reload."),
  ).toBeInTheDocument();
});

test("a host-set role says why it cannot be edited", async () => {
  renderRoute("/setup", api());
  const architect = await openRole("architect");
  expect(
    within(architect).getByText("The app that runs catherd picks this role's model. Change it there."),
  ).toBeInTheDocument();
  expect(within(architect).queryByRole("button", { name: /Add a/ })).not.toBeInTheDocument();
});

test("a role's switch and access level go through the same preview", async () => {
  const { requests } = renderRoute("/setup", api({ "POST /api/setup/preview": () => Response.json(preview()) }));
  const reviewer = await openRole("reviewer");
  expect(
    within(reviewer).getByText("It can change files inside the repo, and nothing outside it."),
  ).toBeInTheDocument();
  await userEvent.click(within(reviewer).getByRole("radio", { name: "Read only" }));
  await waitFor(() => expect(count(requests, "POST /api/setup/preview")).toBe(1));
  expect(
    await requests
      .find((r) => describeRequest(r) === "POST /api/setup/preview")!
      .clone()
      .json(),
  ).toEqual({
    patch: { roles: { reviewer: { access: "read-only" } } },
  });
});

test("a role's switch in the overview turns it off through the preview", async () => {
  const { requests } = renderRoute("/setup", api({ "POST /api/setup/preview": () => Response.json(preview()) }));
  await screen.findByRole("button", { name: "Edit worker" });
  await userEvent.click(within(roleLine("worker")).getByRole("switch", { name: "worker enabled" }));
  await waitFor(() => expect(count(requests, "POST /api/setup/preview")).toBe(1));
  expect(
    await requests
      .find((r) => describeRequest(r) === "POST /api/setup/preview")!
      .clone()
      .json(),
  ).toEqual({ patch: { roles: { worker: { enabled: false } } } });
  expect(screen.queryByRole("dialog", { name: "Worker" })).not.toBeInTheDocument();
});

test("an unknown host makes Setup read-only", async () => {
  renderRoute("/setup", api({}, setup({ host: "unknown" })));
  expect(
    await screen.findByText("Setup is read-only until you choose the app that runs catherd (top of the page)."),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create from defaults" })).toBeDisabled();
  expect(within(roleLine("worker")).getByRole("switch", { name: "worker enabled" })).toBeDisabled();
  await openSettings();
  expect(within(section("Budget")).getByLabelText("USD")).toBeDisabled();
  const worker = await openRole("worker");
  expect(within(worker).getByText("Read only until you choose the app that runs catherd.")).toBeInTheDocument();
  expect(within(worker).getByRole("button", { name: "Add a fallback model" })).toBeDisabled();
  expect(within(worker).getByRole("radio", { name: "Full access" })).toBeDisabled();
});

test("a profile is used for the repo, made active, created and deleted", async () => {
  const { requests } = renderRoute(
    "/setup",
    api({
      "POST /api/profiles/fast/activate": () => new Response(null, { status: 204 }),
      "POST /api/profiles": () => Response.json(saved()),
      "DELETE /api/profiles/fast": () => new Response(null, { status: 204 }),
    }),
  );
  const fast = await screen.findByLabelText("fast");
  await userEvent.click(within(fast).getByRole("button", { name: "Use for this repo" }));
  await waitFor(() => expect(count(requests, "POST /api/profiles/fast/activate")).toBe(1));
  expect(
    await requests
      .find((r) => describeRequest(r) === "POST /api/profiles/fast/activate")!
      .clone()
      .json(),
  ).toEqual({
    repo: "/work/wallet",
  });
  await userEvent.click(within(fast).getByRole("button", { name: "Use everywhere" }));
  await waitFor(() => expect(count(requests, "POST /api/profiles/fast/activate")).toBe(2));
  expect(
    await requests
      .filter((r) => describeRequest(r) === "POST /api/profiles/fast/activate")[1]!
      .clone()
      .json(),
  ).toEqual({
    repo: null,
  });

  await userEvent.type(screen.getByLabelText("New profile"), "careful");
  await userEvent.click(screen.getByRole("button", { name: "Create from defaults" }));
  await waitFor(() => expect(requests.filter((r) => describeRequest(r) === "POST /api/profiles").length).toBe(1));
  expect(
    await requests
      .find((r) => describeRequest(r) === "POST /api/profiles")!
      .clone()
      .json(),
  ).toEqual({ name: "careful" });

  await userEvent.click(within(fast).getByRole("button", { name: "Delete" }));
  await userEvent.click(await within(await screen.findByRole("alertdialog")).findByRole("button", { name: "Delete" }));
  await waitFor(() => expect(count(requests, "DELETE /api/profiles/fast")).toBe(1));
});

test("the active profile and a bound one cannot be deleted, and the page says why", async () => {
  renderRoute("/setup", api());
  const def = await screen.findByLabelText("default");
  expect(within(def).getByRole("button", { name: "Delete" })).toBeDisabled();
  expect(within(def).getByText(/It cannot be deleted\. It is the active profile\./)).toBeInTheDocument();
  expect(within(def).getByRole("button", { name: "Use everywhere" })).toBeDisabled();
  expect(within(def).getByText(/Bound repos: \/work\/wallet/)).toBeInTheDocument();
});

test("access warnings collapse into one line", async () => {
  renderRoute("/setup", api());
  expect(await screen.findByText("2 roles run with full access, wider than catherd's default.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /Why it matters/ }));
  expect(await screen.findByText(/roles\.worker\.access: worker runs with full access/)).toBeInTheDocument();
  expect(screen.getByText(/roles\.reviewer\.access: reviewer runs with full access/)).toBeInTheDocument();
});

test("the section in the address scrolls to its section", async () => {
  const scroll = vi.fn<() => void>();
  Element.prototype.scrollIntoView = scroll;
  renderRoute("/setup?section=failover", api());
  await screen.findByRole("region", { name: /Failover/ });
  await waitFor(() => expect(scroll).toHaveBeenCalled());
  expect(document.activeElement?.id).toBe("setup-failover");
});

test("a setup that cannot load shows the server's message and its recovery command", async () => {
  renderRoute("/setup", (_req, url) =>
    url.pathname === "/api/setup"
      ? Response.json(
          {
            error: {
              message: "no host: catherd cannot tell which agent runs it",
              type: "E_CONFIG_INVALID",
              code: "E_CONFIG_INVALID",
              fix: "catherd --host codex",
            },
          },
          { status: 500 },
        )
      : undefined,
  );
  expect(await screen.findByText(/no host: catherd cannot tell/)).toBeInTheDocument();
  expect(screen.getByText("catherd --host codex")).toBeInTheDocument();
});
