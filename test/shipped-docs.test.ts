/**
 * Contract tests for the Markdown this package ships to npm.
 *
 * Consumers install pm-changelog under their own `.agents/pm/extensions/`
 * tree, so a relative link is only correct when its target is shipped too: a
 * link into this repository's `.agents/pm` tracker resolves inside the
 * consumer's tracker and breaks. Tables are checked against GitHub-flavoured
 * Markdown cell splitting, where an unescaped `|` - even inside inline code -
 * starts a new cell.
 *
 * Links and tables are located with the `marked` GFM lexer, so inline, titled
 * and reference-style links and tables with or without outer pipes are all
 * seen. Cell counts are taken from each table's raw lines, because a parser
 * silently pads or truncates a ragged row - the defect being checked for.
 */
import { describe, it } from "node:test";
import { deepEqual } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { lexer, walkTokens } from "marked";

/** Repository root, resolved from this test file. */
const ROOT = resolve(import.meta.dirname, "..");

/** The `files` allow-list from package.json: everything npm publishes. */
const SHIPPED: readonly string[] = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] }).files;

/** Every shipped Markdown file, as repository-relative paths, from every shipped file and directory. */
const SHIPPED_MARKDOWN: readonly string[] = SHIPPED.flatMap((entry) => {
  const path = join(ROOT, entry);
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return entry.endsWith(".md") ? [entry] : [];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(entry, name));
});

/**
 * Lists the relative link and image targets in `source` (a Markdown file at
 * repository-relative path `file`) that do not resolve to a shipped file.
 * Absolute URLs (any scheme) and same-document anchors are ignored.
 */
function escapingLinks(file: string, source: string): string[] {
  const found: string[] = [];
  walkTokens(lexer(source), (token) => {
    if (token.type !== "link" && token.type !== "image") return;
    const target = String(token.href).split("#")[0];
    if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target)) return;
    const path = relative(ROOT, resolve(ROOT, dirname(file), decodeURI(target)));
    const shipped = existsSync(join(ROOT, path)) && SHIPPED.some((entry) => path === entry || path.startsWith(`${entry}/`));
    if (!shipped) found.push(`${file} -> ${path}`);
  });
  return found;
}

/**
 * Splits one table line into cells the way GitHub does: on every `|` that is
 * not preceded by a backslash, ignoring the optional leading and trailing pipe.
 */
function cellCount(line: string): number {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).length;
}

/** Lists every table row in `source` whose cell count differs from its header's. */
function raggedRows(file: string, source: string): string[] {
  const found: string[] = [];
  walkTokens(lexer(source), (token) => {
    if (token.type !== "table") return;
    const [header, , ...rows] = String(token.raw).trimEnd().split("\n");
    const width = cellCount(header);
    for (const row of rows) {
      if (cellCount(row) !== width) found.push(`${file}: '${row.trim().slice(0, 60)}' has ${cellCount(row)} cells, header has ${width}`);
    }
  });
  return found;
}

describe("shipped Markdown checks", () => {
  it("flag inline, titled and reference-style links into an unshipped tracker", () => {
    const source = [
      "[a](../.agents/pm/issues/a.toon)",
      '[b](../.agents/pm/issues/b.toon "Details")',
      "[c][ref]",
      "![d](../.agents/pm/d.png)",
      "[ok](https://example.com/x) [anchor](#usage) [shipped](../README.md)",
      "",
      "[ref]: ../.agents/pm/issues/c.toon",
    ].join("\n");
    deepEqual(escapingLinks("docs/x.md", source), [
      "docs/x.md -> .agents/pm/issues/a.toon",
      "docs/x.md -> .agents/pm/issues/b.toon",
      "docs/x.md -> .agents/pm/issues/c.toon",
      "docs/x.md -> .agents/pm/d.png",
    ]);
  });

  it("flag ragged rows in tables with and without outer pipes", () => {
    const source = ["| a | b |", "|---|---|", "| `x|y` | z |", "", "a | b", "--- | ---", "1 | 2 | 3", "4 \\| 5 | 6"].join("\n");
    deepEqual(raggedRows("docs/x.md", source), [
      "docs/x.md: '| `x|y` | z |' has 3 cells, header has 2",
      "docs/x.md: '1 | 2 | 3' has 3 cells, header has 2",
    ]);
  });
});

describe("shipped Markdown", () => {
  it("covers the package's documentation", () => {
    deepEqual(["README.md", "CHANGELOG.md", "docs/usage.md"].filter((file) => !SHIPPED_MARKDOWN.includes(file)), []);
  });

  it("only links relatively to files that are shipped with the package", () => {
    deepEqual(SHIPPED_MARKDOWN.flatMap((file) => escapingLinks(file, readFileSync(join(ROOT, file), "utf8"))), []);
  });

  it("keeps every table row at its header's column count", () => {
    deepEqual(SHIPPED_MARKDOWN.flatMap((file) => raggedRows(file, readFileSync(join(ROOT, file), "utf8"))), []);
  });
});
