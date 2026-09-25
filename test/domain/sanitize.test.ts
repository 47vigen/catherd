import { describe, expect, it } from "bun:test";
import { sanitize, secretValues } from "../../src/domain/sanitize.ts";

describe("sanitize", () => {
  const scrub = {
    secrets: ["hunter2-long-secret", "short"],
    paths: [
      { from: "/home/ana", to: "~" },
      { from: "/home/ana/work/repo", to: "<repo>" },
    ],
  };

  it("replaces secrets, key-shaped strings, emails and paths, the repo before the home it sits in", () => {
    const text = [
      "token hunter2-long-secret",
      "key sk-ant-api03-abcdefghijklmnop and sk-proj-abcdefghijklmnopqrstu",
      "Authorization: Bearer abc.def.ghijklmnop",
      "by ana@example.com",
      "edited /home/ana/work/repo/src/a.ts and /home/ana/.claude/x",
    ].join("\n");
    expect(sanitize(text, scrub)).toBe(
      [
        "token <redacted>",
        "key <redacted> and <redacted>",
        "Authorization: <redacted>",
        "by <email>",
        "edited <repo>/src/a.ts and ~/.claude/x",
      ].join("\n"),
    );
  });

  it("leaves short values alone: they would shred ordinary text", () => {
    expect(sanitize("a short word", scrub)).toBe("a short word");
  });

  it("finds credentials by the env var's name", () => {
    expect(
      secretValues({ ANTHROPIC_API_KEY: "a", GH_TOKEN: "b", CLIENT_SECRET: "c", PATH: "/bin", X: undefined }),
    ).toEqual(["a", "b", "c"]);
  });
});
