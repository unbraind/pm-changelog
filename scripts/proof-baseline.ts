import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Proof source selection works with shallow/single-branch clones and archives. */
export interface ProofBaseline { source: string; kind: "merge-base" | "working-tree" }
/** Pin the merge base once when available; otherwise use the checked-out source.
 * The proof owns its behavioral mutation, so a fallback never becomes a no-op. */
export function readProofBaseline(cwd: string): ProofBaseline {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX)$/i.test(key)));
  const root = spawnSync("git", ["rev-parse", "--show-prefix"], { cwd, env, encoding: "utf8" });
  // An archive nested inside another checkout must never borrow its source.
  if (root.status === 0 && root.stdout.trim() === "") {
    const merged = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd, env, encoding: "utf8" });
    if (merged.status === 0) {
      const source = spawnSync("git", ["show", `${merged.stdout.trim()}:src/cli.ts`], { cwd, env, encoding: "utf8" });
      if (source.status === 0) return { source: source.stdout, kind: "merge-base" };
    }
  }
  return { source: readFileSync(join(cwd, "src/cli.ts"), "utf8"), kind: "working-tree" };
}
