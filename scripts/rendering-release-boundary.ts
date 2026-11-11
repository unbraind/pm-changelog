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

/** Prefer the original preparation commit, never a later recovery HEAD. A new
 * explicit base is allowed only after the registry proves the version absent. */
export async function resolveRenderingReleaseBoundary(cwd: string, pmRoot: string, version: string, preparedFrom: string, publication: PublicationState): Promise<RenderingReleaseBoundary | undefined> {
  if (!preparedFrom) return undefined;
  const base = commitId(cwd, preparedFrom);
  if (!base) return undefined;
  const path = relative(cwd, pmRoot).split("\\").join("/") || ".";
  if ( path.startsWith("../") || path.startsWith("/")) return undefined;
  const history = git(cwd, ["rev-list", "--first-parent", "--reverse", base, "--", "package.json"]);
  let commit = history?.trim().split("\n").find((candidate) => candidate && packageVersion(cwd, candidate) === version);
  const tag = commitId(cwd, `refs/tags/v${version}`);
  const published = publication.gitHead ? commitId(cwd, publication.gitHead) : undefined;
  for (const candidate of [tag, published]) {
    if (!candidate || packageVersion(cwd, candidate) !== version || git(cwd, ["merge-base", "--is-ancestor", candidate, base]) === undefined) continue;
    if (!commit || git(cwd, ["merge-base", "--is-ancestor", candidate, commit]) !== undefined) commit = candidate;
  }
  if (publication.state === "unpublished") commit = base;
  if (!commit) return undefined;
  const timestamp = Date.parse(git(cwd, ["show", "-s", "--format=%cI", commit])?.trim() ?? "");
  const files = git(cwd, ["ls-tree", "-r", "-z", "--name-only", commit, "--", path]);
  if (!Number.isFinite(timestamp) || files === undefined) return undefined;
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

/** Query only the public exact-version registry endpoint; uncertainty is not absence. */
export async function readPublicationState(name: string, version: string, registry = "https://registry.npmjs.org"): Promise<PublicationState> {
  const release = parseContractRelease(version);
  if (!release) return { state: "unknown" };
  try {
    const response = await fetch(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(release)}`, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return { state: "unpublished" };
    if (!response.ok) return { state: "unknown" };
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("version" in body) || body.version !== release) return { state: "unknown" };
    const gitHead = "gitHead" in body && typeof body.gitHead === "string" && /^[a-f0-9]{40}$/.test(body.gitHead) ? body.gitHead : undefined;
    return { state: "published", gitHead };
  } catch { return { state: "unknown" }; }
}
