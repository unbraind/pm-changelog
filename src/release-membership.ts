import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, extname, relative, resolve, sep } from "node:path";

import { parseItemDocument, readSettings } from "@unbrained/pm-cli/sdk";

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
  const cwd = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: pmRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const trackerPath = relative(cwd, resolve(pmRoot)).split(sep).join("/");
  const settings = await readSettings(pmRoot);
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
    const tree = execFileSync("git", ["ls-tree", "-r", "-z", window.releaseTag, "--", trackerPath], {
      cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const blobs = new Map<string, ReleaseItemBlob>();
    let hasTrackerItems = false;
    for (const entry of tree.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab < 0) continue;
      const path = entry.slice(tab + 1);
      // Item documents are direct children of type folders. Extension docs,
      // evidence directories, and nested package trackers are not this tracker.
      if (path.slice(trackerPath.length + 1).split("/").length !== 2) continue;
      const extension = extname(path);
      if (extension !== ".toon" && extension !== ".md") continue;
      hasTrackerItems = true;
      const id = basename(path, extension);
      if (!ids.has(id)) continue;
      const [, kind, hash] = entry.slice(0, tab).split(" ");
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
      statuses = parseReleaseItemStatuses(output, blobs, settings.schema);
    }
    const originalIds = new Set(original.map((item) => item.id));
    pending = candidates.filter((item) => {
      if (statuses.get(item.id!) !== item.status?.toLowerCase()) return true;
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
 * Decode length-prefixed Git batch blobs with the public SDK item parser.
 * Byte lengths, hashes, separators, and document identities must agree before
 * any status is trusted; a malformed response must fail changelog generation
 * rather than treating a partial read as evidence that work was unreleased.
 */
export function parseReleaseItemStatuses(
  output: Buffer,
  blobs: ReadonlyMap<string, ReleaseItemBlob>,
  schema: Awaited<ReturnType<typeof readSettings>>["schema"],
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
