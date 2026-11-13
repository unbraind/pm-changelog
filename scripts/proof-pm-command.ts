import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { resolveInstalledPmCommand } from "../src/generator.ts";

/** Launch the installed PM JavaScript entrypoint through this Node executable,
 * without relying on npm's platform-specific shell shims or a node on PATH. */
export function runProofPm(args: readonly string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string> {
  const { argsPrefix } = resolveInstalledPmCommand();
  return spawnSync(process.execPath, [...argsPrefix, ...args], options);
}
