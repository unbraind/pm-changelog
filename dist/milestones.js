import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { EXIT_CODE, PmCliError, listAllComplete } from "@unbrained/pm-cli/sdk";
/** A recoverable release-source failure, shared by CLI and SDK callers. */
export class ReleaseMilestoneError extends PmCliError {
    /** Recovery action safe to show in compact CLI error output. */
    remedy;
    /** Retain a stable code and actionable remedy without exposing backend paths. */
    constructor(code, message, remedy) {
        super(message, EXIT_CODE.GENERIC_FAILURE, { code, nextSteps: [remedy] });
        this.remedy = remedy;
    }
}
/** Reject unsafe names before any backend operation. */
function checkName(name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
        throw new ReleaseMilestoneError("milestone_invalid", "Invalid release milestone name.", "Use 1-80 letters, digits, dots, underscores or hyphens, beginning with a letter or digit; avoid reserved device names.");
    }
}
/** Compare persisted identities by UTF-16 code units, independent of ICU or locale. */
function compareCodeUnits(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}
/** Produce a key-order-independent serialization of normalized JSON for content identity. */
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value).sort(([a], [b]) => compareCodeUnits(a, b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
/** Hash the immutable payload, excluding the fingerprint itself. */
function fingerprint(payload) {
    return createHash("sha256").update(canonical(payload)).digest("hex");
}
/** Require a calendar-valid RFC3339 instant with an explicit offset. */
function validCaptureTime(value) {
    const match = /^(\d{4}-\d{2}-\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
    return !!match && Number.isFinite(Date.parse(value))
        && new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) === match[1];
}
/** Copy only fields consumed by rendering, classification and entry ordering. */
function renderItem(item) {
    const keys = ["id", "title", "status", "type", "priority", "tags", "itemFolder", "url", "assignee", "author", "created_at", "updated_at", "closed_at", "completed_at", "release", "milestone", "breaking", "close_reason", "resolution", "actual_result"];
    const row = Object.fromEntries(keys.filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
    const metadata = Object.fromEntries(["release", "milestone", "breaking"].filter((key) => item.metadata?.[key] !== undefined).map((key) => [key, item.metadata[key]]));
    if (Object.keys(metadata).length)
        row.metadata = metadata;
    for (const key of ["files", "tests", "links"]) {
        if (!Array.isArray(item[key]))
            continue;
        const fields = key === "files" ? ["path"] : key === "tests" ? ["command", "path"] : ["state", "relation", "url"];
        row[key] = item[key].flatMap((entry) => {
            if (typeof entry === "string" && key === "links")
                return [entry];
            if (!entry || typeof entry !== "object")
                return [];
            const record = entry;
            const rendered = Object.fromEntries(fields.filter((field) => typeof record[field] === "string").map((field) => [field, record[field]]));
            return Object.keys(rendered).length ? [rendered] : [];
        });
    }
    return row;
}
/** Validate unknown persisted data before it can affect release attribution. */
export function parseReleaseMilestone(value) {
    let record;
    try {
        record = JSON.parse(JSON.stringify(value));
    }
    catch {
        record = null;
    }
    if (!record || record.schema !== 1 || typeof record.name !== "string" || typeof record.query !== "string"
        || typeof record.capturedAt !== "string"
        || !Array.isArray(record.items) || typeof record.fingerprint !== "string") {
        throw new ReleaseMilestoneError("milestone_invalid", "Invalid release milestone snapshot.", "Read a complete version-1 milestone from its original backend; do not edit snapshots.");
    }
    if (!validCaptureTime(record.capturedAt)) {
        throw new ReleaseMilestoneError("milestone_invalid", "Capture time must be a calendar-valid RFC 3339 instant with an explicit offset.", "Supply a complete timestamp ending in Z or a numeric offset, such as 2026-10-01T12:00:00Z; never edit persisted snapshots.");
    }
    checkName(record.name);
    const ids = new Set();
    for (const item of record.items) {
        if (!item || typeof item.id !== "string" || !item.id.trim() || typeof item.title !== "string" || ids.has(item.id)) {
            throw new ReleaseMilestoneError("milestone_invalid", "Milestone items need unique IDs and titles.", "Capture a complete tracker snapshot with one row per item.");
        }
        ids.add(item.id);
    }
    const payload = { schema: 1, name: record.name, query: record.query, capturedAt: record.capturedAt, items: record.items };
    if (fingerprint(payload) !== record.fingerprint) {
        throw new ReleaseMilestoneError("milestone_invalid", "Release milestone fingerprint does not match its content.", "Recover the original immutable snapshot from the backend or a verified backup.");
    }
    return { ...payload, fingerprint: record.fingerprint };
}
/** Select exact membership with AND terms and comma-separated alternatives. */
function selectItems(items, query) {
    const terms = query.trim() === "*" ? [] : query.trim().split(/\s+/);
    const predicates = terms.map((term) => {
        const match = /^(id|status|type|tag|release):([^\s]+)$/.exec(term);
        if (!match)
            throw new ReleaseMilestoneError("milestone_invalid", "Unsupported milestone item query.", "Use * or space-separated id:, status:, type:, tag:, release: terms; commas mean OR within a term.");
        const [, field, values] = match;
        const alternatives = values.split(",");
        return (item) => field === "tag"
            ? alternatives.some((value) => item.tags?.includes(value))
            : alternatives.includes(String(item[field]));
    });
    return items.filter((item) => predicates.every((predicate) => predicate(item))).sort((a, b) => compareCodeUnits(String(a.id), String(b.id)));
}
/** Reject clock skew before a new name can reorder existing releases. */
async function assertCaptureOrder(store, candidate) {
    for (const key of await store.names()) {
        if (key !== candidate.name && key.toLowerCase() === candidate.name.toLowerCase()) {
            throw new ReleaseMilestoneError("milestone_invalid", "Milestone name collides with an existing case variant.", "Read the original milestone and choose a different lowercase name for a new release.");
        }
        const previous = parseReleaseMilestone(await store.read(key));
        if (Date.parse(candidate.capturedAt) <= Date.parse(previous.capturedAt)) {
            throw new ReleaseMilestoneError("milestone_invalid", "Milestone capture time must advance beyond every existing release.", "Correct the capture clock or obtain a newer backend snapshot, then retry with the new name.");
        }
    }
}
/** Serialize directory publications without stealing another writer's lock. */
async function lockPublication(directory) {
    const lock = join(directory, ".writer-lock");
    for (let attempt = 0;; attempt++) {
        try {
            await mkdir(lock);
            return lock;
        }
        catch (error) {
            if (error.code !== "EEXIST" || attempt === 200)
                throw error;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    }
}
/** Freeze a named release, refusing attempts to change its existing membership. */
export async function createReleaseMilestone(store, name, snapshot, query = "*") {
    checkName(name);
    if (name !== name.toLowerCase())
        throw new ReleaseMilestoneError("milestone_invalid", "New milestone names must be portable across filesystems.", "Use a lowercase milestone name; case variants are not separate releases.");
    const items = JSON.parse(JSON.stringify(selectItems(snapshot.items, query).map(renderItem)));
    const payload = { schema: 1, name, query, capturedAt: snapshot.capturedAt, items };
    const candidate = parseReleaseMilestone({ ...payload, fingerprint: fingerprint(payload) });
    const existing = await store.read(name);
    if (existing === undefined) {
        await assertCaptureOrder(store, candidate);
        if (await store.publish(name, candidate))
            return candidate;
    }
    const original = parseReleaseMilestone(await store.read(name));
    if (original.name !== name && original.name.toLowerCase() === name.toLowerCase()) {
        throw new ReleaseMilestoneError("milestone_invalid", "Milestone name collides with an existing case variant.", "Read the original milestone and choose a different lowercase name for a new release.");
    }
    if (original.name !== name || canonical(original.items.map((item) => item.id).sort()) !== canonical(candidate.items.map((item) => item.id).sort())) {
        throw new ReleaseMilestoneError("milestone_membership_changed", "Named release milestone membership is immutable.", "Keep the existing release and create a new milestone name for the changed membership.");
    }
    return original;
}
/** Read all named boundaries, verifying identities instead of trusting backend rows. */
export async function readReleaseMilestones(store) {
    const names = await store.names();
    if (names.length === 0)
        throw new ReleaseMilestoneError("milestone_missing", "No tracker release milestones exist.", "Run pm changelog milestone create <name> before generating with --milestones.");
    return Promise.all(names.map(async (name) => {
        checkName(name);
        const milestone = parseReleaseMilestone(await store.read(name));
        if (milestone.name !== name)
            throw new ReleaseMilestoneError("milestone_invalid", "Milestone name does not match its backend key.", "Recover the original named snapshot from the backend.");
        return milestone;
    }));
}
/** Attribute each item to its first closed capture, preserving the frozen row.
 * Open captures never reserve membership; live closures stay Unreleased until
 * captured closed. Later tracker edits, reopenings and deletions cannot grow or
 * rewrite an earlier release. */
export function resolveTrackerReleaseHistory(milestones, currentItems) {
    const ordered = milestones.map(parseReleaseMilestone).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || compareCodeUnits(a.name, b.name));
    if (new Set(ordered.map((milestone) => milestone.name.toLowerCase())).size !== ordered.length) {
        throw new ReleaseMilestoneError("milestone_invalid", "Duplicate named release boundaries.", "Pass each immutable release milestone once.");
    }
    if (new Set(ordered.map((milestone) => Date.parse(milestone.capturedAt))).size !== ordered.length) {
        throw new ReleaseMilestoneError("milestone_invalid", "Milestone capture order is ambiguous.", "Use verified snapshots with distinct capture instants; do not infer order from milestone names.");
    }
    const membership = new Map();
    const items = [];
    const windows = [];
    for (const milestone of ordered) {
        const heading = `${milestone.name} - ${new Date(milestone.capturedAt).toISOString().slice(0, 10)}`;
        windows.unshift({ heading, releaseTag: milestone.name });
        for (const frozen of milestone.items) {
            if (frozen.status !== "closed" || membership.has(frozen.id))
                continue;
            const item = frozen;
            items.push({ ...item, release: undefined, metadata: { ...item.metadata, release: undefined } });
            membership.set(frozen.id, heading);
        }
    }
    for (const item of currentItems) {
        if (!item.id || membership.has(item.id))
            continue;
        items.push({ ...item, release: undefined, metadata: { ...item.metadata, release: undefined } });
        membership.set(item.id, "Unreleased");
    }
    return { items, releaseWindows: [{ heading: "Unreleased" }, ...windows], releaseMembership: membership };
}
/** Fail closed on options that would replace or reinterpret frozen boundaries. */
export function assertTrackerMilestoneOptions(conflicts) {
    if (conflicts.some(Boolean))
        throw new ReleaseMilestoneError("milestone_options", "Tracker milestones cannot be combined with git, date-window, version, metadata-grouping, body-preview or external pm source options.", "Use --milestones on its own; use a separate invocation for tag-based generation.");
}
/** Capture a certified full tracker read through the pinned public SDK, without git. */
export async function readTrackerReleaseSnapshot(pmRoot) {
    const result = await listAllComplete({ includeBody: false }, { pmRoot });
    return { capturedAt: new Date().toISOString(), items: result.items.map(renderItem) };
}
/** Filesystem implementation with atomic no-replace publication for concurrent writers. */
export class DirectoryReleaseMilestoneStore {
    /** Tracker-relative release records resolved against the supplied root. */
    directory;
    /** Scope release records to a tracker-owned, portable directory. */
    constructor(pmRoot) { this.directory = join(pmRoot, "changelog", "milestones"); }
    /** Load one snapshot without converting missing records into empty releases. */
    async read(name) {
        checkName(name);
        try {
            return JSON.parse(await readFile(join(this.directory, `${name}.json`), "utf8"));
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw new ReleaseMilestoneError("milestone_storage", "Cannot read release milestone storage.", "Check storage access and recover valid JSON records before retrying.");
        }
    }
    /** Flush file data before no-replace publication, then flush the directory entry. */
    async publish(name, milestone) {
        checkName(name);
        const temporary = join(this.directory, `.${randomUUID()}.tmp`);
        try {
            await mkdir(this.directory, { recursive: true });
            const lock = await lockPublication(this.directory);
            try {
                if (await this.read(name) !== undefined)
                    return false;
                await assertCaptureOrder(this, milestone);
                const handle = await open(temporary, "wx");
                try {
                    try {
                        await handle.writeFile(JSON.stringify(milestone) + "\n");
                        await handle.sync();
                    }
                    finally {
                        await handle.close();
                    }
                    await link(temporary, join(this.directory, `${name}.json`));
                    if (process.platform !== "win32") {
                        const directory = await open(this.directory, "r");
                        try {
                            await directory.sync();
                        }
                        finally {
                            await directory.close();
                        }
                    }
                }
                finally {
                    await unlink(temporary);
                }
                return true;
            }
            finally {
                await rmdir(lock);
            }
        }
        catch (error) {
            if (error instanceof ReleaseMilestoneError)
                throw error;
            throw new ReleaseMilestoneError("milestone_storage", "Cannot publish release milestone storage.", "Wait for active writers and inspect any abandoned .writer-lock; use writable storage supporting atomic hard links or a transactional SDK store adapter.");
        }
    }
    /** Enumerate committed JSON records; incomplete temporary files are invisible. */
    async names() {
        try {
            return (await readdir(this.directory)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
        }
        catch (error) {
            if (error.code === "ENOENT")
                return [];
            throw new ReleaseMilestoneError("milestone_storage", "Cannot list release milestone storage.", "Check tracker storage access before retrying.");
        }
    }
}
//# sourceMappingURL=milestones.js.map