import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PmItem } from "./types.ts";

// Historical built-in folders. Custom types must come from the tracker registry.
const BUILTIN_FOLDERS = new Map(Object.entries({
  issue: "issues", task: "tasks", feature: "features", chore: "chores",
  decision: "decisions", epic: "epics", event: "events", meeting: "meetings",
  milestone: "milestones", plan: "plans", reminder: "reminders",
}));

/** Retain built-in links for standalone JSON, including legacy untyped rows. */
export function builtinItemFolder(type: string | undefined): string | undefined {
  return BUILTIN_FOLDERS.get((type ?? "Issue").toLowerCase());
}

/** Resolve custom folders only from registry metadata; never pluralize a type. */
export function resolveItemFolder(item: PmItem, folders?: Readonly<Record<string, string>>): string {
  const registered = folders?.[item.type ?? "Issue"];
  const folder = item.itemFolder ?? (typeof registered === "string" ? registered : undefined) ?? builtinItemFolder(item.type);
  if (folder === undefined) {
    throw new Error(`No registered tracker folder for item type ${item.type}; supply itemTypeFolders or read items with readPmItems`);
  }
  return folder;
}

/**
 * Yield `](target)` link targets, including optional CommonMark titles, in linear time.
 *
 * Destination scans resume at their stopping character. Title lookahead stops
 * at the next unescaped delimiter, including any later opener of the same style
 * (which follows whitespace and cannot be escaped). Lookahead spans therefore
 * do not overlap within a title style; the three styles bound total work to a
 * constant number of input passes. Failed titles resume at the destination end
 * to retain later links. Untitled links without whitespace keep the old behavior.
 *
 * @param markdown - Rendered changelog markdown.
 * @returns Link targets in document order.
 */
export function* markdownLinkTargets(markdown: string): Generator<string> {
  let from = 0;
  for (;;) {
    const open = markdown.indexOf("](", from);
    if (open === -1) return;
    const start = open + 2;
    let end = start;
    while (end < markdown.length && markdown[end] !== ")" && !/\s/.test(markdown[end]!)) end += 1;
    let close = end;
    while (close < markdown.length && /\s/.test(markdown[close]!)) close += 1;
    const delimiter = markdown[close];
    if (close > end && (delimiter === '"' || delimiter === "'" || delimiter === "(")) {
      let titleEnd = close + 1;
      while (titleEnd < markdown.length) {
        const character = markdown[titleEnd];
        if (character === "\\") titleEnd += 2;
        else if (character === delimiter || (delimiter === "(" && character === ")")) break;
        else titleEnd += 1;
      }
      close = titleEnd;
      if (markdown[close] === (delimiter === "(" ? ")" : delimiter)) {
        close += 1;
        while (close < markdown.length && /\s/.test(markdown[close]!)) close += 1;
      }
    }
    if (end > start && markdown[close] === ")") {
      yield markdown.slice(start, end);
      from = close + 1;
    } else {
      from = Math.max(end, start);
    }
  }
}

/** Fail if a tracker link is absent, is a directory, or escapes the pm root, including symlinks. */
export function checkItemLinks(markdown: string, pmRoot: string, itemUrlBase: string): void {
  const prefix = `${itemUrlBase.replace(/\/$/, "")}/`;
  for (const url of markdownLinkTargets(markdown)) {
    if (!url.startsWith(prefix)) continue;
    const itemPath = decodeURIComponent(url.slice(prefix.length).split(/[?#]/, 1)[0]);
    const path = resolve(pmRoot, itemPath);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Changelog item link has no tracker file: ${itemPath}`);
    }
    const inside = relative(realpathSync(pmRoot), realpathSync(path));
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error(`Changelog item link escapes the pm root: ${itemPath}`);
    }
  }
}
