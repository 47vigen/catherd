import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { describeRequest, renderRoute } from "../../../test/render-route";

const runs = () => Response.json({ items: [], total: 0 });

test("asks which app runs catherd and saves the answer once", async () => {
  let host = "unknown";
  let sent: unknown;
  const { requests } = renderRoute("/runs", async (req, url) => {
    if (url.pathname === "/api/system/version") return Response.json({ catherd: "2.0.0", host });
    if (url.pathname === "/api/setup/host") {
      sent = await req.json();
      host = "codex";
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/runs") return runs();
    return undefined;
  });
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Which app do you run catherd from?");
  expect(alert).toHaveTextContent("Setup stays read-only until you choose. catherd never guesses.");
  await userEvent.click(screen.getByRole("button", { name: "Codex" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(sent).toEqual({ host: "codex" });
  expect(requests.map(describeRequest).filter((r) => r === "POST /api/setup/host")).toHaveLength(1);
});

test("stays out of the way once the host is known", async () => {
  renderRoute("/runs", (_req, url) => {
    if (url.pathname === "/api/system/version") return Response.json({ catherd: "2.0.0", host: "claude-code" });
    if (url.pathname === "/api/runs") return runs();
    return undefined;
  });
  await screen.findByText("v2.0.0");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
