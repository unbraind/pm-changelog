import { spawnSync } from "node:child_process";
import { relative, basename, join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readLocatedItem } from "@unbrained/pm-cli/sdk";
import { parseContractRelease } from "../src/contract-versions.ts";
import type { PmItem } from "../src/types.ts";

/** Registry observation; unknown publication must never authorize a new window. */
export interface PublicationState { state: "published" | "unpublished" | "unknown"; gitHead?: string }
/** An immutable Git boundary plus the native item snapshot it contains. */
export interface RenderingReleaseBoundary { commit: string; timestamp: number; items: Map<string, PmItem> }

/** Read Git objects only in the requested repository, ignoring inherited redirects. */
function git(cwd: string, args: string[]): string | undefined {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX)$/i.test(key)));
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
}

/** Resolve a stable object ID, never a shell expression or a working-tree file. */
function commitId(cwd: string, ref: string): string | undefined {
  return git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])?.trim();
}

/** Read a prepared package version without consulting the mutable working tree. */
function packageVersion(cwd: string, commit: string): string | undefined {
  try { return parseContractRelease(JSON.parse(git(cwd, ["show", `${commit}:package.json`]) ?? "null")?.version); }
  catch { return undefined; }
}

/** Use the published object reachable from main, never the first version commit
 * or recovery HEAD. Only proved unpublished versions get a fresh base window. */
export async function resolveRenderingReleaseBoundary(cwd: string, pmRoot: string, version: string, preparedFrom: string, publication: PublicationState, report: (reason: string) => void = () => {}): Promise<RenderingReleaseBoundary | undefined> {
  /** Refuse incomplete publication evidence without exposing repository paths. */
  const refuse = (reason: string): undefined => { report(reason); return undefined; };
  if (!preparedFrom) return refuse("release_decision_base_missing");
  const base = commitId(cwd, preparedFrom);
  if (!base) return refuse("release_decision_base_unavailable");
  const path = relative(cwd, pmRoot).split("\\").join("/") || ".";
  if (path.startsWith("../") || path.startsWith("/")) return refuse("tracker_outside_release_repository");
  if (publication.state === "unknown") return refuse("publication_state_unknown");
  let commit: string | undefined;
  if (publication.state === "unpublished") commit = base;
  else {
    // A supplied but unproved gitHead must never silently fall back to a tag.
    if (publication.gitHead !== undefined && !/^[a-f0-9]{40}$/i.test(publication.gitHead)) return refuse("published_git_head_invalid");
    if (publication.gitHead !== undefined) commit = commitId(cwd, publication.gitHead);
    else {
      // Without gitHead, accept the v-prefixed or the unprefixed release tag, as release-context does; two tags that disagree prove nothing.
      const prefixed = commitId(cwd, `refs/tags/v${version}`), plain = commitId(cwd, `refs/tags/${version}`);
      if (prefixed && plain && prefixed !== plain) return refuse("published_tag_ambiguous");
      commit = prefixed ?? plain;
    }
    if (!commit) return refuse("published_commit_unavailable");
    if (packageVersion(cwd, commit) !== version) return refuse("published_commit_version_mismatch");
    const main = commitId(cwd, "refs/remotes/origin/main") ?? commitId(cwd, "refs/heads/main");
    if (!main || git(cwd, ["merge-base", "--is-ancestor", commit, main]) === undefined) return refuse("published_commit_not_reachable_from_main");
  }
  if (!commit) return refuse("release_boundary_unavailable");
  const timestamp = Date.parse(git(cwd, ["show", "-s", "--format=%cI", commit])?.trim() ?? "");
  const files = git(cwd, ["ls-tree", "-r", "-z", "--name-only", commit, "--", path]);
  if (!Number.isFinite(timestamp) || files === undefined) return refuse("release_snapshot_unavailable");
  const items = new Map<string, PmItem>();
  const scratch = mkdtempSync(join(tmpdir(), "pm-release-snapshot-"));
  try {
    for (const file of files.split("\0").filter((file) => /\.(?:toon|md)$/.test(file))) {
      const raw = git(cwd, ["show", `${commit}:${file}`]);
      if (raw === undefined) continue;
      try {
        const format = file.endsWith(".toon") ? "toon" : "md";
        const itemPath = join(scratch, `snapshot.${format}`);
        writeFileSync(itemPath, raw);
        const { document } = await readLocatedItem({ id: basename(file, `.${format}`), type: "Issue", itemPath, item_format: format === "toon" ? "toon" : "json_markdown" }, { extensionFieldNames: ["change_facets", "contract_change"] });
        const item = document.metadata;
        if (item.id) items.set(item.id, item);
      } catch { /* An unreadable legacy row supplies no completion proof. */ }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return { commit, timestamp, items };
}

/** Confirm publication from exact metadata, or absence from the full packument. */
export async function readPublicationState(name: string, version: string, registry = "https://registry.npmjs.org"): Promise<PublicationState> {
  const release = parseContractRelease(version);
  if (!release) return { state: "unknown" };
  try {
    const response = await fetch(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(release)}`, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404) {
      const packument = await fetch(`${registry}/${encodeURIComponent(name)}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000),
      });
      if (packument.status !== 200) return { state: "unknown" };
      const document: unknown = await packument.json();
      // Absence is proved only by the requested package's own packument.
      if (!document || typeof document !== "object" || Array.isArray(document)
        || !("name" in document) || document.name !== name
        || !("time" in document) || !document.time || typeof document.time !== "object" || Array.isArray(document.time)
        || !("versions" in document) || !document.versions || typeof document.versions !== "object" || Array.isArray(document.versions)
        || Object.hasOwn(document.time, release) || Object.hasOwn(document.versions, release)) return { state: "unknown" };
      return { state: "unpublished" };
    }
    if (!response.ok) return { state: "unknown" };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("version" in body) || body.version !== release) return { state: "unknown" };
    if ("gitHead" in body && (typeof body.gitHead !== "string" || !/^[a-f0-9]{40}$/i.test(body.gitHead))) return { state: "unknown" };
    const gitHead = "gitHead" in body ? String(body.gitHead) : undefined;
    return { state: "published", gitHead };
  } catch { return { state: "unknown" }; }
}
