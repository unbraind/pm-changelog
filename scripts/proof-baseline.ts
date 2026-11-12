import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Proof source selection works with shallow/single-branch clones and archives. */
export interface ProofBaseline { source: string; kind: "working-tree" }
/** Mutate the checked-out source only, independently of movable remote refs.
 * The proof owns its behavioral mutation, so no historical checkout is needed. */
export function readProofBaseline(cwd: string): ProofBaseline {
  return { source: readFileSync(join(cwd, "src/cli.ts"), "utf8"), kind: "working-tree" };
}
