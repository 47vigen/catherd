import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
  ...over,
});
const LUNA = "codex:gpt-6-luna#high";
const SOL = "codex:gpt-6-sol#high";
const XHIGH = "codex:gpt-6-sol#xhigh";

const setup = (over: object = {}) => ({
  repo: "/work/wallet",
  profile: { name: "default", active: "default", profiles: ["default"] },
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
    warnings: [{ path: "budget.usd", message: "no budget is set" }],
  },
  roles: [
    {
      role: "worker",
      enabled: true,
      hostSet: false,
      rungs: [
        { rung: LUNA, intelligence: 40.2 },
        { rung: SOL, intelligence: 50 },
      ],
      offered: [pair(XHIGH, 55), pair(SOL, 50), pair(LUNA, 40.2)],
    },
    {
      role: "reviewer",
      enabled: true,
      hostSet: false,
      rungs: [{ rung: SOL, intelligence: 50 }],
      offered: [pair(SOL, 50), pair(XHIGH, 55)],
    },
    { role: "artist", enabled: false, hostSet: false, rungs: [], offered: [] },
    { role: "architect", enabled: true, hostSet: true, rungs: [], offered: [pair(SOL, 50)] },
  ],
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

const api = (put?: (req: Request) => Response) => (req: Request, url: URL) => {
  if (url.pathname === "/api/setup") return Response.json(setup());
  if (url.pathname.startsWith("/api/setup/roles/") && put) return put(req);
};

const roleBlock = (name: string) => screen.getByRole("group", { name });

test("shows the catalog and backend rows, the profile's issues and each role's ladder", async () => {
  renderRoute("/setup", api());
  expect(await screen.findByText("checked 3 min ago")).toBeInTheDocument();
  const codex = screen.getByText("codex").closest<HTMLElement>('[role="row"]')!;
  expect(within(codex).getByText(/missing/i)).toBeInTheDocument();
  expect(within(codex).getByText("npm i -g @openai/codex")).toBeInTheDocument();
  expect(screen.getByText("the profile this repo runs on")).toBeInTheDocument();
  expect(screen.getByText(/roles\.worker\.rungs: no usable rung/)).toBeInTheDocument();
  expect(screen.getByText(/budget\.usd: no budget is set/)).toBeInTheDocument();
  const worker = roleBlock("worker");
  expect(
    within(worker)
      .getAllByRole("listitem")
      .map((l) => l.textContent),
  ).toEqual([expect.stringContaining(LUNA), expect.stringContaining(SOL)]);
  expect(within(worker).getByText("40.2")).toBeInTheDocument();
});

test("a role whose rungs the session's host sets says so instead of listing none", async () => {
  renderRoute("/setup", api());
  const architect = await screen.findByRole("group", { name: "architect" });
  expect(within(architect).getByText("Set by the session's host.")).toBeInTheDocument();
  expect(within(architect).queryByText("No rungs.")).not.toBeInTheDocument();
});

test("Edit rungs is off for a role the host sets, with the way to fix it", async () => {
  renderRoute("/setup", api());
  const architect = await screen.findByRole("group", { name: "architect" });
  expect(within(architect).getByRole("button", { name: "Edit rungs" })).toBeDisabled();
  expect(within(architect).getByText(/--host codex\|claude-code|catherd init/)).toBeInTheDocument();
  const reviewer = await screen.findByRole("group", { name: "reviewer" });
  expect(within(reviewer).getByRole("button", { name: "Edit rungs" })).toBeEnabled();
});

test("Edit rungs offers only the role's indexed pairs with the current ones selected", async () => {
  renderRoute("/setup", api());
  await userEvent.click(
    await within(await screen.findByRole("group", { name: "reviewer" })).findByRole("button", { name: "Edit rungs" }),
  );
  const box = await screen.findByRole("listbox", { name: "Indexed pairs" });
  const options = within(box).getAllByRole("option");
  expect(options.map((o) => o.getAttribute("data-key") ?? o.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining(SOL), expect.stringContaining(XHIGH)]),
  );
  expect(options).toHaveLength(2);
  expect(within(box).getByRole("option", { name: new RegExp(SOL) })).toHaveAttribute("aria-selected", "true");
  expect(within(box).getByRole("option", { name: new RegExp(XHIGH) })).toHaveAttribute("aria-selected", "false");
  expect(screen.getAllByText(/intelligence 50\.0 · \$1\.25\/\$10 per M · 80 tok\/s · plan/).length).toBeGreaterThan(0);
});

test("saving sends the picked rungs and refreshes the setup", async () => {
  const { requests } = renderRoute(
    "/setup",
    api(() => Response.json(saved())),
  );
  await userEvent.click(
    await within(await screen.findByRole("group", { name: "reviewer" })).findByRole("button", { name: "Edit rungs" }),
  );
  const box = await screen.findByRole("listbox", { name: "Indexed pairs" });
  await userEvent.click(within(box).getByRole("option", { name: new RegExp(XHIGH) }));
  const before = requests.filter((r) => describeRequest(r) === "GET /api/setup").length;
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  const put = await waitFor(() => requests.find((r) => describeRequest(r) === "PUT /api/setup/roles/reviewer")!);
  expect(((await put.clone().json()) as { rungs: string[] }).rungs.toSorted()).toEqual([SOL, XHIGH].toSorted());
  expect(await screen.findByText("Saved. reviewer climbs 2 rungs.")).toBeInTheDocument();
  await waitFor(() =>
    expect(requests.filter((r) => describeRequest(r) === "GET /api/setup").length).toBeGreaterThan(before),
  );
});

test("a refused save shows every error and keeps the drawer open", async () => {
  renderRoute(
    "/setup",
    api(() =>
      Response.json(
        saved({
          saved: false,
          errors: [
            { path: "roles.reviewer.rungs", message: "codex:gpt-6-sol#ultra has no Slopalytics intelligence index" },
            { path: "roles.reviewer.rungs", message: "a second problem", fix: "catherd catalog sync" },
          ],
        }),
      ),
    ),
  );
  await userEvent.click(
    await within(await screen.findByRole("group", { name: "reviewer" })).findByRole("button", { name: "Edit rungs" }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Save" }));
  expect(await screen.findByText(/has no Slopalytics intelligence index/)).toBeInTheDocument();
  expect(screen.getByText(/a second problem/)).toBeInTheDocument();
  expect(screen.getByRole("listbox", { name: "Indexed pairs" })).toBeInTheDocument();
});

test("a role with no indexed pair says to sync the catalog", async () => {
  renderRoute("/setup", api());
  await userEvent.click(
    await within(await screen.findByRole("group", { name: "artist" })).findByRole("button", { name: "Edit rungs" }),
  );
  expect(
    await screen.findByText("No indexed pair fits this role. Run catherd catalog sync, then reload."),
  ).toBeInTheDocument();
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
