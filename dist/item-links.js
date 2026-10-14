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
/** Fail if a tracker link is absent, is a directory, or escapes the pm root, including symlinks. */
export function checkItemLinks(markdown, pmRoot, itemUrlBase) {
    const prefix = `${itemUrlBase.replace(/\/$/, "")}/`;
    for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
        const url = match[1];
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