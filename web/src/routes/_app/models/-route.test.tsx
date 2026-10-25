import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { client } from "../../../client/client.gen";
import { renderRoute } from "../../../test/render-route";

afterEach(() => client.setConfig({ baseUrl: "", fetch: undefined }));

const pt = (effort: string, usd: number | null, measured: boolean) => ({
  effort,
  rung: `codex:m#${effort}`,
  intelligence: 60,
  usd,
  measured,
});
const model = (id: string, points: ReturnType<typeof pt>[], lab = "openai", superseded = false) => ({
  id,
  name: null,
  lab,
  backends: ["codex"],
  superseded,
  points,
});
const THREE = [
  model("gpt-6-sol", [pt("low", 0.1, true), pt("high", 0.4, true)]),
  model("gpt-6-luna", [pt("low", 0.05, false), pt("high", 0.2, false)]),
  model("claude-opus-5-5", [pt("low", 0.5, true), pt("high", 1.8, true), pt("max", 5, false)], "anthropic"),
];
const page = (models: object[], indexedAt: string | null = "2026-10-24T08:00:00.000Z") =>
  renderRoute("/models", (_req, url) =>
    url.pathname === "/api/catalog" ? Response.json({ indexedAt, models }) : undefined,
  );

describe("the Models page", () => {
  it("the page lists the available models and plots one line each", async () => {
    page(THREE);
    expect(await screen.findByRole("img", { name: "Cost vs intelligence of 3 models" })).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.getByText(/Slopalytics .* fetched 2026-10-24/)).toBeInTheDocument();
  });

  it("switching a model off hides its line", async () => {
    page(THREE);
    await screen.findByRole("img", { name: "Cost vs intelligence of 3 models" });
    const sw = screen.getAllByRole("switch")[0]!;
    await userEvent.click(sw);
    expect(await screen.findByRole("img", { name: "Cost vs intelligence of 2 models" })).toBeInTheDocument();
    await userEvent.click(sw);
    expect(await screen.findByRole("img", { name: "Cost vs intelligence of 3 models" })).toBeInTheDocument();
  });

  it("a model a newer version replaces starts switched off, and can be switched on", async () => {
    page([...THREE, model("gpt-5.6-sol", [pt("low", 0.2, true), pt("high", 0.6, true)], "openai", true)]);
    expect(await screen.findByRole("img", { name: "Cost vs intelligence of 3 models" })).toBeInTheDocument();
    const sw = screen.getAllByRole("switch")[3]!;
    expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    expect(await screen.findByRole("img", { name: "Cost vs intelligence of 4 models" })).toBeInTheDocument();
    expect(sw).toBeChecked();
  });

  it("Log is the default and Linear switches the axis", async () => {
    page(THREE);
    const group = await screen
      .findByRole("radiogroup", { name: "Cost axis" })
      .catch(() => screen.findByLabelText("Cost axis"));
    const log = within(group).getByRole("radio", { name: "Log" });
    const linear = within(group).getByRole("radio", { name: "Linear" });
    expect(log).toBeChecked();
    await userEvent.click(linear);
    await waitFor(() => expect(linear).toBeChecked());
  });

  it("a model with estimated costs says so", async () => {
    page([
      model("gpt-6-sol", [
        pt("low", 1, true),
        pt("medium", 1, true),
        pt("high", 1, true),
        pt("xhigh", 1, false),
        pt("max", 1, false),
      ]),
    ]);
    expect(await screen.findByText("2 of 5 costs estimated")).toBeInTheDocument();
  });

  it("with nothing indexed the page says how to sync", async () => {
    page([], null);
    expect(
      await screen.findByText("No model is indexed yet. Run catherd catalog sync, then reload."),
    ).toBeInTheDocument();
  });
});
