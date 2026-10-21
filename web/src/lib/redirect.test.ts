import { safeRedirect } from "./redirect";

test.each([
  ["/logs?page=2", "/logs?page=2"],
  ["/", "/"],
  ["//evil.example", "/"],
  ["/\\evil.example", "/"],
  ["https://evil.example/x", "/"],
  ["javascript:alert(1)", "/"],
  ["/login", "/"], // never loop back to login
  ["/login?redirect=/keys", "/"],
  [undefined, "/"],
  [42, "/"],
])("safeRedirect(%j) = %j", (raw, want) => expect(safeRedirect(raw)).toBe(want));
