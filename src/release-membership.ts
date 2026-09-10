import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseItemDocument, readSettingsWithMetadata, SETTINGS_DEFAULTS } from "@unbrained/pm-cli/sdk";

import { createChangelog } from "./generator.ts";
import type { GenerateChangelogOptions, PmItem } from "./types.ts";

/** Immutable Git blob identity and the SDK parser format selected by its path. */
export interface ReleaseItemBlob {
  hash: string;
  format: "toon" | "json_markdown";
}

/**
 * Verify timestamp-derived release placement against the tracked item state
 * in each Git tag. A completion made on an unmerged branch can precede a
 * release cut without belonging to that release. Carry such items forward to
 * the first tag containing their selected status, or to the pending window.
 *
 * Explicit release declarations remain authoritative. Tags predating the
 * tracker retain timestamp placement because their absent tracker cannot
 * prove whether imported historical work shipped. Caller-supplied JSON and
 * non-Git SDK generation can omit this resolver and retain pure generation.
 * The returned map records only corrections and never mutates tracker data.
 */
export async function resolveGitReleaseMembership(
  options: GenerateChangelogOptions,
  pmRoot: string,
): Promise<ReadonlyMap<string, string | null>> {
  const assignments = new Map<string, string | null>();
  const windows = options.releaseWindows;
  if (!windows?.length || !existsSync(resolve(pmRoot, "settings.json"))) return assignments;
  let cwd: string;
  try {
    cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: pmRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`Cannot locate the Git work tree for ${pmRoot}: ${String(error)}`, { cause: error });
  }
  const trackerPath = relative(cwd, realpathSync(pmRoot)).split(sep).join("/");
  const trackerPrefix = trackerPath ? `${trackerPath}/` : "";
  const sections = createChangelog({ ...options, releaseMembership: undefined }).sections;
  let pending: PmItem[] = [];
  for (const window of [...windows].reverse()) {
    const original = sections.find((section) => section.heading === window.heading)!.items;
    const candidates = [...pending, ...original.filter((item) =>
      item.id && !item.release?.trim() && !String(item.metadata?.release ?? "").trim())];
    if (candidates.length === 0) continue;
    if (!window.releaseTag || !window.until) {
      for (const item of pending) assignments.set(item.id!, window.heading);
      pending = [];
      continue;
    }
    const ids = new Set(candidates.map((item) => item.id!));
    const tree = execFileSync("git", ["ls-tree", "-r", "-z", window.releaseTag, "--", "."], {
      cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const blobs = new Map<string, ReleaseItemBlob>();
    const treeObjects = new Map<string, string>();
    let hasTrackerItems = false;
    for (const entry of tree.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const path = entry.slice(tab + 1);
      const [, kind, hash] = entry.slice(0, tab).split(" ");
      treeObjects.set(path, hash!);
      // Item documents are direct children of type folders. Extension docs,
      // evidence directories, and nested package trackers are not this tracker.
      if (!path.startsWith(trackerPrefix) || path.slice(trackerPrefix.length).split("/").length !== 2) continue;
      const extension = extname(path);
      if (extension !== ".toon" && extension !== ".md") continue;
      hasTrackerItems = true;
      const id = basename(path, extension);
      if (!ids.has(id)) continue;
      if (kind !== "blob") throw new Error(`Release item ${id} in ${window.releaseTag} is not a Git blob`);
      if (blobs.has(id)) throw new Error(`Release tag ${window.releaseTag} contains duplicate item ${id}`);
      blobs.set(id, { hash: hash!, format: extension === ".toon" ? "toon" : "json_markdown" });
    }
    // Before a tracker existed, absence is not evidence against a historical
    // completion. Keep those original placements while retaining pending work
    // already proven absent from a newer tracker-bearing release.
    if (!hasTrackerItems) continue;
    let statuses = new Map<string, string>();
    if (blobs.size > 0) {
      const output = execFileSync("git", ["cat-file", "--batch"], {
        cwd,
        input: [...blobs.values()].map((blob) => blob.hash).join("\n") + "\n",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      statuses = parseReleaseItemStatuses(output, blobs, await readTaggedSchema(cwd, trackerPath, treeObjects));
    }
    const originalIds = new Set(original.map((item) => item.id));
    pending = candidates.filter((item) => {
      const taggedStatus = statuses.get(item.id!);
      if (taggedStatus === undefined || taggedStatus !== item.status?.toLowerCase()) return true;
      if (!originalIds.has(item.id)) assignments.set(item.id!, window.heading);
      return false;
    });
  }
  // An explicit includeUnreleased:false window list must not re-date work into
  // an older release when no containing tag exists.
  for (const item of pending) assignments.set(item.id!, null);
  return assignments;
}

/**
 * Reconstruct only the tagged settings and their four schema documents in an
 * isolated directory, then let the public SDK validate and load that snapshot.
 * Current checkout rules must never reject valid historical item metadata.
 * Relative schema files may live elsewhere in the repository; paths escaping
 * it cannot provide versioned evidence and are refused before filesystem access.
 */
async function readTaggedSchema(
  cwd: string,
  trackerPath: string,
  treeObjects: ReadonlyMap<string, string>,
): Promise<typeof SETTINGS_DEFAULTS.schema> {
  const settingsHash = treeObjects.get(trackerPath ? `${trackerPath}/settings.json` : "settings.json");
  if (!settingsHash) return SETTINGS_DEFAULTS.schema;
  const content = execFileSync("git", ["cat-file", "blob", settingsHash], { cwd, encoding: "utf8" });
  const raw: unknown = JSON.parse(content);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("Invalid tagged settings document");
  const schema = (raw as Record<string, unknown>).schema;
  const files = typeof schema === "object" && schema !== null && !Array.isArray(schema)
    ? (schema as Record<string, unknown>).files : undefined;
  const configuredFiles = typeof files === "object" && files !== null && !Array.isArray(files)
    ? files as Record<string, unknown> : {};
  const scratch = mkdtempSync(join(tmpdir(), "pm-changelog-tag-schema-"));
  try {
    const root = resolve(scratch, trackerPath);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "settings.json"), content);
    for (const section of ["types", "statuses", "fields", "workflows"] as const) {
      const configured = configuredFiles[section];
      const path = configured === undefined ? SETTINGS_DEFAULTS.schema.files[section]! : configured;
      if (typeof path !== "string" || !path.trim()) throw new Error(`Invalid tagged schema path: ${section}`);
      const target = resolve(root, path);
      const withinRepository = relative(scratch, target);
      if (isAbsolute(path) || withinRepository === ".." || withinRepository.startsWith(`..${sep}`)) {
        throw new Error(`Tagged schema path is outside the repository: ${section}`);
      }
      const hash = treeObjects.get(withinRepository.split(sep).join("/"));
      if (!hash) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, execFileSync("git", ["cat-file", "blob", hash], { cwd }));
    }
    const loaded = await readSettingsWithMetadata(root);
    const failures = loaded.warnings.filter((warning) => !warning.startsWith("runtime_schema_bootstrap_created:")
      && warning !== "settings_item_format_legacy_json_markdown_coerced_to_toon");
    if (failures.length) throw new Error(`Invalid tagged schema evidence: ${failures.join(", ")}`);
    return loaded.settings.schema;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Decode length-prefixed Git batch blobs with the public SDK item parser.
 * Byte lengths, hashes, separators, and document identities must agree before
 * any status is trusted; a malformed response must fail changelog generation
 * rather than treating a partial read as evidence that work was unreleased.
 */
export function parseReleaseItemStatuses(
  output: Buffer,
  blobs: ReadonlyMap<string, ReleaseItemBlob>,
  schema: typeof SETTINGS_DEFAULTS.schema,
): Map<string, string> {
  const statuses = new Map<string, string>();
  let offset = 0;
  for (const [id, blob] of blobs) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString("utf8");
    const [hash, kind, sizeText] = header.split(" ");
    const size = Number(sizeText);
    if (end < 0 || hash !== blob.hash || kind !== "blob" || !Number.isSafeInteger(size) || size < 0
      || end + size + 1 >= output.length || output[end + size + 1] !== 10) {
      throw new Error(`Incomplete Git blob response for release item ${id}`);
    }
    const content = output.subarray(end + 1, end + 1 + size).toString("utf8");
    const document = parseItemDocument(content, { format: blob.format, schema });
    if (document.metadata.id !== id) throw new Error(`Release item filename and document identity disagree: ${id}`);
    statuses.set(id, document.metadata.status.toLowerCase());
    offset = end + size + 2;
  }
  if (offset !== output.length) throw new Error("Unexpected trailing Git blob data in release membership response");
  return statuses;
}
