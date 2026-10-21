import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { EXIT_CODE, PmCliError, listAllComplete } from "@unbrained/pm-cli/sdk";
import type { ChangelogReleaseWindow, PmItem } from "./types.ts";

/** Stable refusal identifiers for automation and recovery. */
export type ReleaseMilestoneErrorCode = "milestone_invalid" | "milestone_membership_changed" | "milestone_missing" | "milestone_storage" | "milestone_options";

/** A recoverable release-source failure, shared by CLI and SDK callers. */
export class ReleaseMilestoneError extends PmCliError {
  /** Machine-readable refusal discriminator for retry policy. */
  declare readonly code: ReleaseMilestoneErrorCode;
  /** Recovery action safe to show in compact CLI error output. */
  readonly remedy: string;
  /** Retain a stable code and actionable remedy without exposing backend paths. */
  constructor(code: ReleaseMilestoneErrorCode, message: string, remedy: string) {
    super(message, EXIT_CODE.GENERIC_FAILURE, { code, nextSteps: [remedy] });
    this.remedy = remedy;
  }
}

/** Complete backend read captured at a single logical tracker revision. */
export interface TrackerReleaseSnapshot {
  readonly capturedAt: string;
  readonly items: readonly PmItem[];
}

/** Content-verified, immutable named boundary and its exact tracker membership. */
export interface ReleaseMilestone extends TrackerReleaseSnapshot {
  readonly schema: 1;
  readonly name: string;
  readonly query: string;
  readonly fingerprint: string;
}

/** Backend adapter: publish must be atomic and must never replace an existing name. */
export interface ReleaseMilestoneStore {
  read(name: string): Promise<unknown | undefined>;
  publish(name: string, milestone: ReleaseMilestone): Promise<boolean>;
  names(): Promise<string[]>;
}

/** Reject unsafe names before any backend operation. */
function checkName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) {
    throw new ReleaseMilestoneError("milestone_invalid", "Invalid release milestone name.", "Use 1-80 letters, digits, dots, underscores or hyphens, beginning with a letter or digit.");
  }
}

/** Compare persisted identities by UTF-16 code units, independent of ICU or locale. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Produce a key-order-independent serialization for content identity. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => compareCodeUnits(a, b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash the immutable payload, excluding the fingerprint itself. */
function fingerprint(payload: Omit<ReleaseMilestone, "fingerprint">): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

/** Validate unknown persisted data before it can affect release attribution. */
export function parseReleaseMilestone(value: unknown): ReleaseMilestone {
  const record = value as Partial<ReleaseMilestone> | null;
  if (!record || record.schema !== 1 || typeof record.name !== "string" || typeof record.query !== "string"
    || typeof record.capturedAt !== "string" || !Number.isFinite(Date.parse(record.capturedAt))
    || !Array.isArray(record.items) || typeof record.fingerprint !== "string") {
    throw new ReleaseMilestoneError("milestone_invalid", "Invalid release milestone snapshot.", "Read a complete version-1 milestone from its original backend; do not edit snapshots.");
  }
  checkName(record.name);
  const ids = new Set<string>();
  for (const item of record.items) {
    if (!item || typeof item.id !== "string" || !item.id.trim() || typeof item.title !== "string" || ids.has(item.id)) {
      throw new ReleaseMilestoneError("milestone_invalid", "Milestone items need unique IDs and titles.", "Capture a complete tracker snapshot with one row per item.");
    }
    ids.add(item.id);
  }
  const payload = { schema: 1 as const, name: record.name, query: record.query, capturedAt: record.capturedAt, items: record.items };
  if (fingerprint(payload) !== record.fingerprint) {
    throw new ReleaseMilestoneError("milestone_invalid", "Release milestone fingerprint does not match its content.", "Recover the original immutable snapshot from the backend or a verified backup.");
  }
  return JSON.parse(JSON.stringify({ ...payload, fingerprint: record.fingerprint })) as ReleaseMilestone;
}

/** Select exact membership with AND terms and comma-separated alternatives. */
function selectItems(items: readonly PmItem[], query: string): PmItem[] {
  const terms = query.trim() === "*" ? [] : query.trim().split(/\s+/);
  const predicates = terms.map((term) => {
    const match = /^(id|status|type|tag|release):([^\s]+)$/.exec(term);
    if (!match) throw new ReleaseMilestoneError("milestone_invalid", "Unsupported milestone item query.", "Use * or space-separated id:, status:, type:, tag:, release: terms; commas mean OR within a term.");
    const [, field, values] = match;
    const alternatives = values.split(",");
    return (item: PmItem): boolean => field === "tag"
      ? alternatives.some((value) => item.tags?.includes(value))
      : alternatives.includes(String(item[field as "id" | "status" | "type" | "release"]));
  });
  return items.filter((item) => predicates.every((predicate) => predicate(item))).sort((a, b) => compareCodeUnits(String(a.id), String(b.id)));
}

/** Freeze a named release, refusing attempts to change its existing membership. */
export async function createReleaseMilestone(store: ReleaseMilestoneStore, name: string, snapshot: TrackerReleaseSnapshot, query = "*"): Promise<ReleaseMilestone> {
  checkName(name);
  const payload = { schema: 1 as const, name, query, capturedAt: snapshot.capturedAt, items: selectItems(snapshot.items, query) };
  const candidate = parseReleaseMilestone({ ...payload, fingerprint: fingerprint(payload) });
  const existing = await store.read(name);
  if (existing === undefined && await store.publish(name, candidate)) return candidate;
  const original = parseReleaseMilestone(await store.read(name));
  if (original.name !== name || canonical(original.items.map((item) => item.id).sort()) !== canonical(candidate.items.map((item) => item.id).sort())) {
    throw new ReleaseMilestoneError("milestone_membership_changed", "Named release milestone membership is immutable.", "Keep the existing release and create a new milestone name for the changed membership.");
  }
  return original;
}

/** Read all named boundaries, verifying identities instead of trusting backend rows. */
export async function readReleaseMilestones(store: ReleaseMilestoneStore): Promise<ReleaseMilestone[]> {
  const names = await store.names();
  if (names.length === 0) throw new ReleaseMilestoneError("milestone_missing", "No tracker release milestones exist.", "Run pm changelog milestone create <name> before generating with --milestones.");
  return Promise.all(names.map(async (name) => {
    checkName(name);
    const milestone = parseReleaseMilestone(await store.read(name));
    if (milestone.name !== name) throw new ReleaseMilestoneError("milestone_invalid", "Milestone name does not match its backend key.", "Recover the original named snapshot from the backend.");
    return milestone;
  }));
}

/** Convert frozen membership into generator input, retaining late-close attribution.
 * The first captured closed row keeps its prose, even after a later reopening.
 * Open members may close in a later snapshot or the current tracker and still
 * belong to the first boundary containing their ID. Nonmembers stay Unreleased. */
export function resolveTrackerReleaseHistory(milestones: readonly ReleaseMilestone[], currentItems: readonly PmItem[]): {
  items: PmItem[]; releaseWindows: ChangelogReleaseWindow[]; releaseMembership: ReadonlyMap<string, string>;
} {
  const ordered = milestones.map(parseReleaseMilestone).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || compareCodeUnits(a.name, b.name));
  if (new Set(ordered.map((milestone) => milestone.name)).size !== ordered.length) {
    throw new ReleaseMilestoneError("milestone_invalid", "Duplicate named release boundaries.", "Pass each immutable release milestone once.");
  }
  const completed = new Map<string, PmItem>();
  for (const milestone of ordered) {
    for (const item of milestone.items) {
      if (item.status === "closed" && !completed.has(item.id!)) completed.set(item.id!, item);
    }
  }
  const current = new Map(currentItems.map((item) => [item.id, item]));
  const membership = new Map<string, string>();
  const items: PmItem[] = [];
  const windows: ChangelogReleaseWindow[] = [];
  for (const milestone of ordered) {
    const heading = `${milestone.name} - ${new Date(milestone.capturedAt).toISOString().slice(0, 10)}`;
    windows.unshift({ heading, releaseTag: milestone.name });
    for (const frozen of milestone.items) {
      if (membership.has(frozen.id!)) continue;
      const item = completed.get(frozen.id!) ?? current.get(frozen.id) ?? frozen;
      items.push({ ...item, release: undefined, metadata: { ...item.metadata, release: undefined } });
      membership.set(frozen.id!, heading);
    }
  }
  for (const item of currentItems) {
    if (!item.id || membership.has(item.id)) continue;
    items.push({ ...item, release: undefined, metadata: { ...item.metadata, release: undefined } });
    membership.set(item.id, "Unreleased");
  }
  return { items, releaseWindows: [{ heading: "Unreleased" }, ...windows], releaseMembership: membership };
}

/** Fail closed on options that would replace or reinterpret frozen boundaries. */
export function assertTrackerMilestoneOptions(conflicts: readonly unknown[]): void {
  if (conflicts.some(Boolean)) throw new ReleaseMilestoneError("milestone_options", "Tracker milestones cannot be combined with git, date-window, version or metadata-grouping release sources.", "Use --milestones on its own; use a separate invocation for tag-based generation.");
}

/** Capture a certified full tracker read through the pinned public SDK, without git. */
export async function readTrackerReleaseSnapshot(pmRoot: string): Promise<TrackerReleaseSnapshot> {
  const result = await listAllComplete({ includeBody: true }, { pmRoot });
  return { capturedAt: new Date().toISOString(), items: result.items };
}

/** Filesystem implementation with atomic no-replace publication for concurrent writers. */
export class DirectoryReleaseMilestoneStore implements ReleaseMilestoneStore {
  /** Tracker-relative release records resolved against the supplied root. */
  readonly directory: string;
  /** Scope release records to a tracker-owned, portable directory. */
  constructor(pmRoot: string) { this.directory = join(pmRoot, "changelog", "milestones"); }
  /** Load one snapshot without converting missing records into empty releases. */
  async read(name: string): Promise<unknown | undefined> {
    checkName(name);
    try { return JSON.parse(await readFile(join(this.directory, `${name}.json`), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ReleaseMilestoneError("milestone_storage", "Cannot read release milestone storage.", "Check storage access and recover valid JSON records before retrying.");
    }
  }
  /** Flush file data before no-replace publication, then flush the directory entry. */
  async publish(name: string, milestone: ReleaseMilestone): Promise<boolean> {
    checkName(name);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true });
      const handle = await open(temporary, "wx");
      try {
        try {
          await handle.writeFile(JSON.stringify(milestone) + "\n");
          await handle.sync();
        } finally { await handle.close(); }
        await link(temporary, join(this.directory, `${name}.json`));
        const directory = await open(this.directory, "r");
        try { await directory.sync(); }
        finally { await directory.close(); }
      } finally { await unlink(temporary); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw new ReleaseMilestoneError("milestone_storage", "Cannot publish release milestone storage.", "Use writable storage supporting atomic hard links, or a transactional SDK store adapter.");
    }
  }

  /** Enumerate committed JSON records; incomplete temporary files are invisible. */
  async names(): Promise<string[]> {
    try { return (await readdir(this.directory)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ReleaseMilestoneError("milestone_storage", "Cannot list release milestone storage.", "Check tracker storage access before retrying.");
    }
  }
}
