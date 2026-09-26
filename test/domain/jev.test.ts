import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_MAX,
  canonicalJson,
  JevFileSchema,
  judgeRoute,
  judgeVerdict,
  laneState,
  parseReply,
  questionSetId,
  requestKey,
  scrubFree,
  scrubSecrets,
  VERDICT_OPTIONS,
} from "../../src/domain/jev.ts";

const root = join(import.meta.dir, "..", "..");
const jevFile = () =>
  JevFileSchema.parse(JSON.parse(readFileSync(join(root, "catalog", "jev.json"), "utf8")));
const fixture = (n: string): unknown =>
  JSON.parse(readFileSync(join(root, "test", "fixtures", "jev", n), "utf8"));
const route = () => jevFile().sets["route-v2"];

describe("the route-v2 question set", () => {
  it("asks kind as a choice with other, difficulty as a four-level score, and the seven nouls", () => {
    const q = route().questions;
    expect(q.kind?.type).toBe("choice");
    expect(Object.keys(q.kind?.type === "choice" ? q.kind.criteria : {})).toContain("other");
    expect(q.difficulty?.type === "score" && q.difficulty.criteria).toHaveLength(4);
    expect(Object.keys(q).filter((k) => q[k]?.type === "noul")).toEqual([
      "names_pattern",
      "mechanical",
      "shared_state",
      "unclear_cause",
      "open_design",
      "cross_boundary",
      "outside_repo",
    ]);
  });

  it("names each set by a content hash that changes with any question or threshold", () => {
    const f = jevFile();
    const id = questionSetId(f, "route-v2");
    expect(id).toMatch(/^route-v2#[0-9a-f]{8}$/);
    expect(questionSetId(f, "route-v2")).toBe(id);
    f.sets["route-v2"].rule.trackMin = 0.75;
    expect(questionSetId(f, "route-v2")).not.toBe(id);
  });

  it("hashes requests independently of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(JSON.stringify({ a: undefined, b: 1 }));
    expect(requestKey("m", { a: 1, b: 2 }, {})).toBe(requestKey("m", { b: 2, a: 1 }, {}));
  });
});

describe("laneState", () => {
  it("keeps the header as fields and drops header lines, code and secrets from the body", () => {
    const s = laneState(
      [
        "# M1.L2 — jobs endpoint",
        "Owns: src/jobs.ts, test/jobs.test.ts",
        "Fast check: bun test test/jobs.test.ts",
        "Kind: repo_code",
        "Difficulty: build",
        "Add GET /jobs like src/users.ts does.",
        "```ts",
        "const secretCode = 1;",
        "```",
        "Use OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv and token: ghp_abcdefghijklmnopqrstuvwxyz0123",
      ].join("\n"),
    );
    expect(s.title).toBe("M1.L2 — jobs endpoint");
    expect(s.owns).toEqual(["src/jobs.ts", "test/jobs.test.ts"]);
    expect(s.fast_check).toBe("bun test test/jobs.test.ts");
    expect(s.body).toContain("Add GET /jobs like src/users.ts does.");
    expect(s.body).toContain("[code omitted]");
    for (const gone of ["secretCode", "sk-abc", "ghp_", "Kind:", "Difficulty:", "Owns:"])
      expect(s.body).not.toContain(gone);
  });

  it("scrubs secrets from the owned paths", () => {
    const s = laneState(
      "# M1.L1 — x\nOwns: src/jobs.ts, config/sk-abcdefghijklmnopqrstuv.env, api_key=hunter22secret\nDo it.",
    );
    expect(s.owns).toEqual(["src/jobs.ts", "config/[secret].env", "api_key=[secret]"]);
    expect(JSON.stringify(s)).not.toContain("sk-abc");
    expect(JSON.stringify(s)).not.toContain("hunter22");
  });

  it("caps the body", () => {
    expect(laneState(`# M1.L1 — x\n${"word ".repeat(5000)}`).body.length).toBe(BODY_MAX + 1);
  });

  it("drops an unclosed code fence to the end, and never cuts a surrogate pair in half", () => {
    const s = laneState("# M1.L1 — x\nKeep this.\n```ts\nconst leaked = 1;\n");
    expect(s.body).toBe("Keep this.\n[code omitted]");
    const cut = laneState(`# M1.L1 — x\n${"a".repeat(BODY_MAX - 1)}😀tail`).body;
    expect(cut).toBe(`${"a".repeat(BODY_MAX - 1)}…`);
  });

  it("drops an indented fence, as under a list item, with ``` and ~~~", () => {
    const s = laneState(
      [
        "# M1.L1 — x",
        "1. Set the env:",
        "   ```bash",
        "   export TOKEN_X=abc",
        "   ```",
        "2. Clean up:",
        "\t~~~",
        "\trm -rf /",
        "\t~~~",
        "3. Done.",
      ].join("\n"),
    );
    expect(s.body).toBe("1. Set the env:\n[code omitted]\n2. Clean up:\n[code omitted]\n3. Done.");
  });

  it("scrubs private keys and key=value secrets", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(`${pem} DB_PASSWORD=hunter22 AKIAABCDEFGHIJKLMNOP`)).toBe(
      "[secret] DB_PASSWORD=[secret] [secret]",
    );
  });
});

describe("scrubFree", () => {
  it("drops fenced code and secrets from free text, and caps it like a lane's body", () => {
    expect(scrubFree("The call leaks.\n```ts\nconst leaked = 1;\n```\nDB_PASSWORD=hunter22\n")).toBe(
      "The call leaks.\n[code omitted]\nDB_PASSWORD=[secret]",
    );
    expect(scrubFree("Broken:\n~~~\nopen fence runs on")).toBe("Broken:\n[code omitted]");
    expect(scrubFree("word ".repeat(5000))).toHaveLength(BODY_MAX + 1);
  });

  it("drops an indented fence", () => {
    expect(
      scrubFree("Steps:\n- run:\n  ```sh\n  rm -rf /\n  ```\n- then:\n    ~~~\n    leaked\n    ~~~\nend"),
    ).toBe("Steps:\n- run:\n[code omitted]\n- then:\n[code omitted]\nend");
  });
});

describe("scrubSecrets", () => {
  it("redacts bearer tokens and a URL's password, keeping its user", () => {
    expect(scrubSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_ghi")).toBe(
      "Authorization: Bearer [secret]",
    );
    expect(scrubSecrets("curl -H 'authorization: bearer 0123456789abcdefXYZ' x")).toBe(
      "curl -H 'authorization: bearer [secret]' x",
    );
    expect(
      scrubSecrets("DATABASE_URL is postgres://app:hunter22@db:5432/x and https://user:p%40ss@h.io/"),
    ).toBe("DATABASE_URL is postgres://app:[secret]@db:5432/x and https://user:[secret]@h.io/");
    expect(scrubSecrets("see https://example.com:8080/path and a Bearer of news")).toBe(
      "see https://example.com:8080/path and a Bearer of news",
    );
  });
});

describe("parseReply", () => {
  it("reads choice, score and noul answers with the model and usage", () => {
    const r = parseReply(route().questions, fixture("route-v2-track-a.json"));
    expect(r.ok && r.model).toBe("jev-1.13.0");
    expect(r.ok && r.usage).toEqual({ input_tokens: 812, output_tokens: 210 });
    expect(r.ok && r.answers.names_pattern).toEqual({ type: "noul", noul: 0.93 });
  });

  it("refuses a missing answer, a wrong type and a choice outside the criteria", () => {
    const qs = route().questions;
    const body = fixture("route-v2-track-a.json") as { answers: Record<string, unknown> };
    const without = { ...body, answers: { ...body.answers, outside_repo: undefined } };
    expect(parseReply(qs, without)).toEqual({ ok: false, error: "no valid answer to outside_repo" });
    const wrongType = { ...body, answers: { ...body.answers, mechanical: body.answers.kind } };
    expect(parseReply(qs, wrongType)).toEqual({ ok: false, error: "no valid answer to mechanical" });
    const f = fixture("finding-design.json") as { answers: { finding: { choice: string } } };
    f.answers.finding.choice = "maybe";
    expect(parseReply(jevFile().sets.finding.questions, f)).toEqual({
      ok: false,
      error: "no valid answer to finding",
    });
    expect(parseReply(qs, fixture("auth-error.json"))).toEqual({ ok: false, error: "unexpected response" });
  });

  it("refuses a score probability outside the question's levels", () => {
    const body = fixture("route-v2-track-a.json") as {
      answers: { difficulty: { probabilities: Record<string, number> } };
    };
    body.answers.difficulty.probabilities["4"] = 0;
    expect(parseReply(route().questions, body)).toEqual({
      ok: false,
      error: "no valid answer to difficulty",
    });
  });
});

describe("judgeRoute", () => {
  const judge = (n: string) => {
    const r = parseReply(route().questions, fixture(n));
    if (!r.ok) throw new Error(r.error);
    return judgeRoute(route().rule, r.answers);
  };

  it("puts copy+build mass on Track A even when no single level is confident", () => {
    expect(judge("route-v2-track-a.json")).toMatchObject({
      kind: "repo_code",
      track: "A",
      difficulty: "build",
      pA: 0.9,
      pB: 0.1,
      rule: "P(A) 0.9 ≥ 0.8",
    });
  });

  it("puts logic+hard mass on Track B, hard when level 3 leads", () => {
    expect(judge("route-v2-track-b.json")).toMatchObject({ track: "B", difficulty: "hard", pB: 0.95 });
  });

  it("decides nothing in the dead band, and no kind below kindMin", () => {
    const j = judge("route-v2-unsure.json");
    expect(j).toMatchObject({ kind: null, pKind: 0.58, track: null, difficulty: null, pA: 0.55 });
    expect(j.nouls.outside_repo).toBe(0.6);
  });

  it("decides at exactly the threshold, and never takes other as a kind", () => {
    const rule = route().rule;
    const at = judgeRoute(rule, {
      kind: { type: "choice", choice: "other", confidence: 1, probabilities: { other: 1 } },
      difficulty: {
        type: "score",
        score: 1,
        confidence: 0.5,
        probabilities: { "0": 0.5, "1": 0.3, "2": 0.2 },
      },
    });
    expect([at.kind, at.track, at.difficulty]).toEqual([null, "A", "copy"]);
  });

  it("reaches the threshold on a sum that floating point rounds below it (0.1 + 0.7)", () => {
    const score = (probabilities: Record<string, number>) => ({
      type: "score" as const,
      score: 1,
      confidence: 0.5,
      probabilities,
    });
    const a = judgeRoute(route().rule, { difficulty: score({ "0": 0.1, "1": 0.7, "2": 0.2 }) });
    expect(a).toMatchObject({ track: "A", difficulty: "build", pA: 0.8, rule: "P(A) 0.8 ≥ 0.8" });
    const b = judgeRoute(route().rule, { difficulty: score({ "1": 0.2, "2": 0.1, "3": 0.7 }) });
    expect(b).toMatchObject({ track: "B", difficulty: "hard", pB: 0.8 });
  });

  it("logs no kind probability when the kind answer has none", () => {
    const j = judgeRoute(route().rule, {
      kind: { type: "choice", choice: "ui", confidence: 0, probabilities: {} },
    });
    expect([j.kind, j.pKind]).toEqual([null, null]);
  });

  it("refuses a rule whose tracks are not two levels each", () => {
    const f = JSON.parse(readFileSync(join(root, "catalog", "jev.json"), "utf8"));
    f.sets["route-v2"].rule.trackA = ["0", "1", "2"];
    expect(JevFileSchema.safeParse(f).success).toBe(false);
  });
});

describe("judgeVerdict", () => {
  const f = jevFile();

  it("falls back, in each verdict set, to one of its caller's options, which are the set's criteria", () => {
    for (const set of ["finding", "same-defect"] as const) {
      const { questions, rule } = f.sets[set];
      const q = questions[set];
      expect(Object.keys(q?.type === "choice" ? q.criteria : {})).toEqual([...VERDICT_OPTIONS[set]]);
      expect(VERDICT_OPTIONS[set] as readonly string[]).toContain(rule.fallback);
    }
  });
  const at = (p: number) => ({
    finding: { type: "choice" as const, choice: "design", confidence: 0.5, probabilities: { design: p } },
  });
  const read = (n: string, set: "finding" | "same-defect") => {
    const r = parseReply(f.sets[set].questions, fixture(n));
    return r.ok ? r.answers : null;
  };

  it("takes finding at p ≥ 0.83 and same-defect at p ≥ 0.85, as 0.x did", () => {
    expect(
      judgeVerdict(
        f.sets.finding.rule,
        "finding",
        ["design", "code", "unclear"],
        read("finding-design.json", "finding"),
      ),
    ).toEqual({
      value: "design",
      probability: 1,
      confidence: 1,
      source: "jev",
    });
    expect(
      judgeVerdict(
        f.sets.finding.rule,
        "finding",
        ["design", "code", "unclear"],
        read("finding-unsure.json", "finding"),
      ),
    ).toMatchObject({
      value: "code",
      source: "default",
    });
    expect(
      judgeVerdict(
        f.sets["same-defect"].rule,
        "same-defect",
        ["yes", "no"],
        read("same-defect-yes.json", "same-defect"),
      ).value,
    ).toBe("yes");
  });

  it("decides at exactly the threshold and falls back just below it", () => {
    const opts = ["design", "code", "unclear"] as const;
    expect(judgeVerdict(f.sets.finding.rule, "finding", opts, at(0.83))).toMatchObject({
      value: "design",
      source: "jev",
    });
    expect(judgeVerdict(f.sets.finding.rule, "finding", opts, at(0.829))).toMatchObject({
      value: "code",
      source: "default",
    });
    const same = (p: number) => ({
      "same-defect": { type: "choice" as const, choice: "yes", confidence: 0.5, probabilities: { yes: p } },
    });
    expect(judgeVerdict(f.sets["same-defect"].rule, "same-defect", ["yes", "no"], same(0.85)).value).toBe(
      "yes",
    );
    expect(judgeVerdict(f.sets["same-defect"].rule, "same-defect", ["yes", "no"], same(0.849)).value).toBe(
      "no",
    );
  });

  it("falls back without answers", () => {
    expect(judgeVerdict(f.sets["same-defect"].rule, "same-defect", ["yes", "no"], null)).toEqual({
      value: "no",
      probability: null,
      confidence: null,
      source: "default",
    });
  });
});
