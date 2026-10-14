import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
// Historical built-in folders. Custom types must come from the tracker registry.
const BUILTIN_FOLDERS = new Map(Object.entries({
    issue: "issues", task: "tasks", feature: "features", chore: "chores",
    decision: "decisions", epic: "epics", event: "events", meeting: "meetings",
    milestone: "milestones", plan: "plans", reminder: "reminders",
}));
/** Retain built-in links for standalone JSON, including legacy untyped rows. */
export function builtinItemFolder(type) {
    return BUILTIN_FOLDERS.get((type ?? "Issue").toLowerCase());
}
/** Resolve custom folders only from registry metadata; never pluralize a type. */
export function resolveItemFolder(item, folders) {
    const registered = folders?.[item.type ?? "Issue"];
    const folder = item.itemFolder ?? (typeof registered === "string" ? registered : undefined) ?? builtinItemFolder(item.type);
    if (folder === undefined) {
        throw new Error(`No registered tracker folder for item type ${item.type}; supply itemTypeFolders or read items with readPmItems`);
    }
    return folder;
}
/**
 * Yield every `](target)` link target in one linear pass.
 *
 * Equivalent to matching `/\]\(([^)\s]+)\)/g`, which CodeQL flags as polynomial
 * on untrusted input such as many repetitions of `](!`. When a scan stops at
 * whitespace or the end of input, every `](` inside the scanned span would stop
 * at the same character, so resuming there loses no match and keeps the work
 * linear.
 *
 * @param markdown - Rendered changelog markdown.
 * @returns Link targets in document order.
 */
export function* markdownLinkTargets(markdown) {
    let from = 0;
    for (;;) {
        const open = markdown.indexOf("](", from);
        if (open === -1)
            return;
        const start = open + 2;
        let end = start;
        while (end < markdown.length && markdown[end] !== ")" && !/\s/.test(markdown[end]))
            end += 1;
        if (end > start && markdown[end] === ")") {
            yield markdown.slice(start, end);
            from = end + 1;
        }
        else {
            from = Math.max(end, start);
        }
    }
}
/** Fail if a tracker link is absent, is a directory, or escapes the pm root, including symlinks. */
export function checkItemLinks(markdown, pmRoot, itemUrlBase) {
    const prefix = `${itemUrlBase.replace(/\/$/, "")}/`;
    for (const url of markdownLinkTargets(markdown)) {
        if (!url.startsWith(prefix))
            continue;
        const itemPath = decodeURIComponent(url.slice(prefix.length));
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
//# sourceMappingURL=item-links.js.map