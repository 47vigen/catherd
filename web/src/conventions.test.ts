import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname);
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const own = files(SRC).filter((f) => !f.includes("/client/") && !f.endsWith("routeTree.gen.ts"));

test("the only CSS is the HeroUI entry and the theme", () => {
  const css = own.filter((f) => f.endsWith(".css")).map((f) => relative(SRC, f));
  expect(css.sort()).toEqual(["index.css", "theme.css"]);
  expect(readFileSync(join(SRC, "index.css"), "utf8")).toMatch(/^@import "tailwindcss";\n@import "@heroui\/styles";\n/);
});
test("no inline styles", () => {
  for (const f of own.filter((f) => f.endsWith(".tsx"))) expect(readFileSync(f, "utf8"), f).not.toMatch(/\sstyle=\{/);
});
test("no hook files in component folders", () => {
  expect(own.filter((f) => /\/-?components\/.*\/?use[A-Z][^/]*\.tsx?$/.test(f))).toEqual([]);
});
test("no virtualization", () => {
  for (const f of own) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bVirtualizer\b/);
});
test("no source or vendor brand outside derived-file headers", () => {
  for (const f of own.filter((f) => !f.endsWith(".test.ts"))) {
    const body = readFileSync(f, "utf8").replace(
      /^\/\/ Derived from maximhq\/bifrost ui\/\S+ \(Apache-2\.0\); modified\.\n/,
      "",
    );
    // "maximum" (maximumFractionDigits) is a JavaScript word, not the brand.
    expect(body, f).not.toMatch(/remora|bifrost|maxim(?!um)|cliproxy/i);
  }
});
test("the copy is English", () => {
  for (const f of own) expect(readFileSync(f, "utf8"), f).not.toMatch(/[\u0600-\u06FF]/);
});
test("every derived file carries the exact header and is listed in THIRD_PARTY_NOTICES.md", () => {
  const notices = readFileSync(join(SRC, "../../THIRD_PARTY_NOTICES.md"), "utf8");
  for (const f of own.filter((f) => readFileSync(f, "utf8").startsWith("// Derived from maximhq/bifrost"))) {
    expect(readFileSync(f, "utf8").split("\n")[0]).toMatch(
      /^\/\/ Derived from maximhq\/bifrost ui\/\S+ \(Apache-2\.0\); modified\.$/,
    );
    expect(notices).toContain(`web/src/${relative(SRC, f)}`);
  }
});
