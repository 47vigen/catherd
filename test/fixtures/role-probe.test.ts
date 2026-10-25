import { expect, it } from "bun:test";

// Run by test/helpers.test.ts from a role's shell: test/preload.ts must have dropped the role.
it("runs as no role", () => {
  expect(process.env.CATHERD_ROLE).toBeUndefined();
  expect(process.env.CATHERD_DISPATCH_ID).toBeUndefined();
});
