/** Prove quick Bun project installation and bunx execution of this exact packed build. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand, scaledBudget, ACCEPTANCE_CHILD_BUDGET_MS } from "./acceptance-process.ts";

const repository = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pm-bun-smoke-"));
const ephemeral = mkdtempSync(join(tmpdir(), "pm-bunx-smoke-"));
const env = { ...process.env, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull,
  DO_NOT_TRACK: "1", BUN_INSTALL_CACHE_DIR: join(scratch, "cache") };
/** Keep every external command bounded and preserve its exit-status assertion. */
async function run(command: string, args: string[], cwd = scratch): Promise<string> {
  const result = await runCommand(command, args, { cwd, env, timeoutMs: scaledBudget(ACCEPTANCE_CHILD_BUDGET_MS) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  const packed = JSON.parse(await run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repository)) as { filename: string }[];
  const archive = join(scratch, packed[0].filename);
  const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await run("bun", ["add", "--ignore-scripts", archive, `@unbrained/pm-cli@${manifest.devDependencies["@unbrained/pm-cli"]}`]);
  assert.match(await run("bun", [join(scratch, "node_modules/pm-changelog/dist/cli.js"), "--help"]), /pm-changelog/);
  assert.match(await run("bun", ["x", "--bun", "--package", archive, "pm-changelog", "--help"], ephemeral), /pm-changelog/);
  console.log("Bun packed project install and bunx help passed");
} finally {
  rmSync(ephemeral, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
