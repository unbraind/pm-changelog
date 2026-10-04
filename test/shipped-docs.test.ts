/**
 * Contract tests for the Markdown this package ships to npm.
 *
 * Consumers install pm-changelog under their own `.agents/pm/extensions/`
 * tree, so a relative link is only correct when its target is shipped too: a
 * link into this repository's `.agents/pm` tracker resolves inside the
 * consumer's tracker and breaks. Tables are checked against GitHub-flavoured
 * Markdown cell splitting, where an unescaped `|` - even inside inline code -
 * starts a new cell.
 */
import { describe, it } from "node:test";
import { deepEqual } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Repository root, resolved from this test file. */
const ROOT = resolve(import.meta.dirname, "..");

/** The `files` allow-list from package.json: everything npm publishes. */
const SHIPPED: readonly string[] = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] }).files;

/** Every shipped Markdown file, as repository-relative paths. */
const SHIPPED_MARKDOWN: readonly string[] = SHIPPED.flatMap((entry) => {
  const path = join(ROOT, entry);
  if (entry.endsWith(".md")) return [entry];
  if (entry !== "docs") return [];
  return readdirSync(path, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(entry, name));
});

/**
 * Splits one table row into cells the way GitHub does: on every `|` that is
 * not preceded by a backslash, ignoring the optional leading and trailing pipe.
 */
function cells(row: string): string[] {
  return row.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/);
}

describe("shipped Markdown", () => {
  it("only links relatively to files that are shipped with the package", () => {
    const escaping = SHIPPED_MARKDOWN.flatMap((file) =>
      [...readFileSync(join(ROOT, file), "utf8").matchAll(/\]\(([^)\s]+)\)/g)]
        .map((match) => match[1].split("#")[0])
        .filter((target) => target !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(target))
        .map((target) => relative(ROOT, resolve(ROOT, dirname(file), target)))
        .filter((target) => !existsSync(join(ROOT, target)) || !SHIPPED.some((entry) => target === entry || target.startsWith(`${entry}/`)))
        .map((target) => `${file} -> ${target}`),
    );
    deepEqual(escaping, []);
  });

  it("keeps every table row at its header's column count", () => {
    const ragged = SHIPPED_MARKDOWN.flatMap((file) => {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      const found: string[] = [];
      let width = 0;
      lines.forEach((line, index) => {
        if (!line.trimStart().startsWith("|")) {
          width = 0;
          return;
        }
        if (width === 0) {
          width = cells(line).length;
          return;
        }
        if (cells(line).length !== width) found.push(`${file}:${index + 1} has ${cells(line).length} cells, header has ${width}`);
      });
      return found;
    });
    deepEqual(ragged, []);
  });
});
