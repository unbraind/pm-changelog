import { spawnSync } from "node:child_process";
const DEFAULT_TITLE = "Changelog";
const DEFAULT_STATUSES = ["closed"];
const CATEGORY_ORDER = [
    "Added",
    "Changed",
    "Fixed",
    "Removed",
    "Security",
    "Deprecated",
    "Other",
];
export function generateChangelog(options) {
    const title = options.title ?? DEFAULT_TITLE;
    const items = filterItems(options);
    const sections = buildSections(items, options);
    const lines = [`# ${title}`, ""];
    if (sections.length === 0) {
        if (options.includeEmpty) {
            const heading = buildVersionHeading(options.version, options.date);
            lines.push(`## ${heading}`, "", "No changes.", "");
        }
        return lines.join("\n").trimEnd() + "\n";
    }
    for (const section of sections) {
        lines.push(`## ${section.heading}`, "");
        const grouped = groupByCategory(section.items);
        for (const category of CATEGORY_ORDER) {
            const categoryItems = grouped.get(category);
            if (!categoryItems || categoryItems.length === 0)
                continue;
            lines.push(`### ${category}`, "");
            for (const item of categoryItems) {
                lines.push(`- ${formatItem(item)}`);
            }
            lines.push("");
        }
    }
    return lines.join("\n").trimEnd() + "\n";
}
export function readPmItems(options = {}) {
    const pmBin = options.pmBin ?? "pm";
    const args = ["list-all", "--json"];
    if (options.pmRoot) {
        args.unshift("--path", options.pmRoot);
    }
    const result = spawnSync(pmBin, args, { encoding: "utf-8" });
    if (result.status !== 0) {
        throw new Error(result.stderr || `${pmBin} list-all --json failed`);
    }
    return parsePmItemsJson(result.stdout);
}
export function parsePmItemsJson(raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
        return parsed;
    if (isRecord(parsed) && Array.isArray(parsed.items))
        return parsed.items;
    throw new Error("Expected pm JSON to be an array or an object with an items array");
}
function filterItems(options) {
    const statuses = new Set((options.includeStatuses ?? DEFAULT_STATUSES).map((status) => status.toLowerCase()));
    const since = options.since ? Date.parse(options.since) : undefined;
    const until = options.until ? Date.parse(options.until) : undefined;
    return options.items
        .filter((item) => item.title)
        .filter((item) => {
        if (statuses.size === 0)
            return true;
        return statuses.has(String(item.status ?? "").toLowerCase());
    })
        .filter((item) => {
        const timestamp = item.closed_at ?? item.updated_at ?? item.created_at;
        if (!timestamp)
            return since === undefined && until === undefined;
        const value = Date.parse(timestamp);
        if (Number.isNaN(value))
            return false;
        if (since !== undefined && value < since)
            return false;
        if (until !== undefined && value > until)
            return false;
        return true;
    })
        .sort(compareItems);
}
function buildSections(items, options) {
    if (options.groupBy === "milestone" && !options.version) {
        const byMilestone = new Map();
        for (const item of items) {
            const key = item.milestone?.trim() || "Unreleased";
            const group = byMilestone.get(key) ?? [];
            group.push(item);
            byMilestone.set(key, group);
        }
        return Array.from(byMilestone.entries()).map(([heading, groupedItems]) => ({
            heading,
            items: groupedItems,
        }));
    }
    return [
        {
            heading: buildVersionHeading(options.version, options.date),
            items,
        },
    ];
}
function buildVersionHeading(version, date) {
    const heading = version?.trim() || "Unreleased";
    const stamp = date?.trim() || formatLocalDate(new Date());
    return `${heading} - ${stamp}`;
}
function groupByCategory(items) {
    const grouped = new Map();
    for (const item of items) {
        const category = classifyItem(item);
        const categoryItems = grouped.get(category) ?? [];
        categoryItems.push(item);
        grouped.set(category, categoryItems);
    }
    return grouped;
}
function classifyItem(item) {
    const values = [
        item.type,
        ...(item.tags ?? []),
        item.title,
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    if (hasAny(values, ["security", "cve", "vulnerability"]))
        return "Security";
    if (hasAny(values, ["deprecated", "deprecation"]))
        return "Deprecated";
    if (hasAny(values, ["removed", "remove", "deleted", "delete"]))
        return "Removed";
    if (hasAny(values, ["fix", "fixed", "bug", "bugfix", "hotfix", "regression"]))
        return "Fixed";
    if (hasAny(values, ["feature", "feat", "added", "add", "new"]))
        return "Added";
    if (hasAny(values, ["change", "changed", "refactor", "update", "updated", "improve"])) {
        return "Changed";
    }
    return "Other";
}
function hasAny(value, needles) {
    return needles.some((needle) => new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(value));
}
function formatItem(item) {
    const title = escapeMarkdown(item.title.trim());
    const id = item.id ? ` (${escapeMarkdown(item.id)})` : "";
    const link = item.url ? ` [link](${item.url})` : "";
    return `${title}${id}${link}`;
}
function compareItems(a, b) {
    const aTime = Date.parse(a.closed_at ?? a.updated_at ?? a.created_at ?? "");
    const bTime = Date.parse(b.closed_at ?? b.updated_at ?? b.created_at ?? "");
    if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) {
        return bTime - aTime;
    }
    return a.title.localeCompare(b.title);
}
function escapeMarkdown(value) {
    return value.replace(/([\\`*_[\]()#|>])/g, "\\$1");
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function formatLocalDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
//# sourceMappingURL=generator.js.map