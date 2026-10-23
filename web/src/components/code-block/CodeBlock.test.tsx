import { render, waitFor } from "@testing-library/react";

import { CodeBlock, normalizeLang } from "./CodeBlock";

test("fence names and aliases resolve to one grammar, and anything unknown is text", () => {
  const names = ["md", "markdown", "ts", "TypeScript", "tsx", "js", "jsx", "sh", "bash", "zsh", "patch", "yml", "json"];
  expect(names.map(normalizeLang)).toEqual([
    "markdown",
    "markdown",
    "typescript",
    "typescript",
    "tsx",
    "javascript",
    "jsx",
    "shellscript",
    "shellscript",
    "shellscript",
    "diff",
    "yaml",
    "json",
  ]);
  expect([undefined, "", "cobol", "text"].map(normalizeLang)).toEqual(["text", "text", "text", "text"]);
});

test("typescript gets syntax colours once its grammar has loaded", async () => {
  const { container } = render(<CodeBlock code={"const a = 1;"} lang="ts" />);
  expect(container.querySelector("code")).toHaveTextContent("const a = 1;");
  await waitFor(() => expect(container.querySelector(".code-keyword")).toHaveTextContent("const"));
});

test("markdown and bash are highlighted too", async () => {
  const md = render(<CodeBlock code={"# Title\n\n`x`"} lang="markdown" />);
  await waitFor(() => expect(md.container.querySelectorAll("code span span").length).toBeGreaterThan(0));
  const sh = render(<CodeBlock code={'echo "hi" # note'} lang="bash" />);
  await waitFor(() => expect(sh.container.querySelector(".code-comment")).toHaveTextContent("# note"));
});

test("a diff tints added, removed and hunk lines", async () => {
  const { container } = render(<CodeBlock code={"@@ -1 +1 @@\n-old\n+new\n same"} lang="diff" />);
  expect(container.querySelector("[data-line='added']")).toHaveTextContent("+new");
  expect(container.querySelector("[data-line='removed']")).toHaveTextContent("-old");
  expect(container.querySelector("[data-line='hunk']")).toHaveTextContent("@@ -1 +1 @@");
  await waitFor(() => expect(container.querySelector("[data-line='added'] .text-success")).not.toBeNull());
});

test("an unknown language and plain text stay as written", () => {
  const { container } = render(<CodeBlock code={"anything <b> here"} lang="cobol" />);
  expect(container.querySelector("code")).toHaveTextContent("anything <b> here");
  expect(container.querySelector("code span")).toBeNull();
});
