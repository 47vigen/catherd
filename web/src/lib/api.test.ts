import { getSession, login } from "../client";
import { client } from "../client/client.gen";
import { configureClient, errorMessage } from "./api";

afterEach(() => {
  client.interceptors.response.clear();
  vi.unstubAllGlobals();
});

// Node's Request rejects relative URLs, so the tests give the client an absolute base after configuring it.
const status401 = () =>
  vi.fn<typeof fetch>(async () =>
    Response.json({ error: { message: "Unauthorized", type: "auth", code: "unauthorized" } }, { status: 401 }),
  );

test("errorMessage reads the API error shape", () => {
  expect(errorMessage({ error: { code: "x", message: "Alias has a cycle" } })).toBe("Alias has a cycle");
  expect(errorMessage(new Error("boom"))).toBe("boom");
  expect(errorMessage(null)).toBe("Request failed");
  expect(errorMessage("plain")).toBe("Request failed");
});

test("configureClient calls onUnauthorized on a 401 outside /api/auth/login", async () => {
  const onUnauthorized = vi.fn<() => void>();
  configureClient(onUnauthorized);
  const fetch = status401();
  client.setConfig({ baseUrl: "http://localhost", fetch });
  await getSession();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
});

test("a wrong token does not trigger onUnauthorized", async () => {
  const onUnauthorized = vi.fn<() => void>();
  configureClient(onUnauthorized);
  client.setConfig({ baseUrl: "http://localhost", fetch: status401() });
  const res = await login({ body: { token: "wrong" } });
  expect(res.error).toEqual({ error: { message: "Unauthorized", type: "auth", code: "unauthorized" } });
  expect(onUnauthorized).not.toHaveBeenCalled();
});
