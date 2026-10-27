/** Exercise the packed correction feature through real npm/Bun installation and launcher modes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInit, runCreate, PmClient } from "@unbrained/pm-cli/sdk";
import { decode } from "@toon-format/toon";
import { createReleaseMilestone, DirectoryReleaseMilestoneStore, readReleaseCorrectionView, readTrackerReleaseSnapshot } from "../src/index.ts";

const scratch = mkdtempSync(join(tmpdir(), "pm-correction-pack-"));
const repository = resolve(import.meta.dirname, "..");
const pinned = (JSON.parse(readFileSync(join(repository, "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies["@unbrained/pm-cli"];
const childEnv = { ...process.env, NPM_CONFIG_CACHE: join(scratch, "npm-cache"), NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull, DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(scratch), BUN_INSTALL: join(scratch, "bun-global"), BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache") };
/** Capture commands without publishing installer noise or scratch paths. */
function run(binary: string, args: string[], cwd = scratch): string {
  return execFileSync(binary, args, { cwd, env: childEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
}
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repository)) as { filename: string }[];
  const archive = join(scratch, packed[0].filename);
  const root = join(scratch, "tracker/.agents/pm");
  await runInit("accept", { path: root }, { defaults: true, agentGuidance: "skip" });
  await runCreate({ id: "accept-claim", title: "Published acceptance claim", type: "Feature", status: "closed", closeReason: "Delivered", createMode: "progressive", unset: ["parent", "goal", "objective", "sprint", "release"] }, { path: root, author: "acceptance" });
  await createReleaseMilestone(new DirectoryReleaseMilestoneStore(root), "v1", await readTrackerReleaseSnapshot(root));
  const client = new PmClient({ pmRoot: root, author: "acceptance" });
  await client.update("accept-claim", { title: "Edited wording captured later", unset: ["parent", "goal", "objective", "sprint", "release"] });
  const later = await createReleaseMilestone(new DirectoryReleaseMilestoneStore(root), "a-later", { ...(await readTrackerReleaseSnapshot(root)), capturedAt: new Date(Date.now() + 1000).toISOString() });
  const prefix = join(scratch, "npm-global");
  run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", archive, `@unbrained/pm-cli@${pinned}`]);
  const extension = join(root, "extensions/pm-changelog");
  cpSync(join(prefix, "lib/node_modules/pm-changelog"), extension, { recursive: true });
  mkdirSync(join(extension, "node_modules"), { recursive: true });
  if (!existsSync(join(extension, "node_modules/@unbrained"))) symlinkSync(join(prefix, "lib/node_modules/@unbrained"), join(extension, "node_modules/@unbrained"), "junction");
  const paths: string[] = [];
  let checks = 0;
  /** Check actual append, exact replay and both compact views against the SDK-read state. */
  async function accept(name: string, launch: (args: string[]) => string): Promise<void> {
    const view = await readReleaseCorrectionView(root, "v1", "accept-claim");
    assert.equal(view.original, "Published acceptance claim");
    const wrongFile = join(scratch, "later-snapshot.json");
    writeFileSync(wrongFile, JSON.stringify({ schema: 1, release: later.name, item: "accept-claim", milestone: later.fingerprint, id: `wrong-${name}`, supersedes: "", expectedRevision: later.fingerprint, wording: "Unpublished snapshot wording must refuse", evidence: ["docs/release-corrections.md"] }));
    for (const format of ["json", "toon"]) for (const action of [["view", "--release", later.name, "--item", "accept-claim"], ["append", "--input", wrongFile]]) {
      assert.throws(() => launch([...action, "--format", format]), (error: unknown) => {
        assert.ok(error && typeof error === "object" && "stderr" in error);
        assert.match(String(error.stderr), /correction_missing/); return true;
      }); checks++;
    }
    const file = join(scratch, "correction.json");
    writeFileSync(file, JSON.stringify({ schema: 1, release: "v1", item: "accept-claim", milestone: view.milestone, id: name, supersedes: view.chain.at(-1)?.id ?? "", expectedRevision: view.revision,
      wording: `  Packed ${name} acceptance\r\n `, evidence: ["docs/release-corrections.md"] }));
    assert.equal(JSON.parse(launch(["append", "--input", file, "--json"])).changed, true); checks++;
    assert.equal(JSON.parse(launch(["append", "--input", file, "--json"])).changed, false); checks++;
    const expected = await readReleaseCorrectionView(root, "v1", "accept-claim");
    for (const flags of [["--json"], ["--format", "toon"]]) {
      const output = launch(["view", "--release", "v1", "--item", "accept-claim", ...flags]);
      assert.deepEqual(flags[0] === "--json" ? JSON.parse(output) : decode(output), expected); checks++;
    }
    paths.push(name);
  }
  await accept("npm-global", (args) => run(join(prefix, "bin/pm-changelog"), ["corrections", "--pm-root", root, ...args]));
  await accept("npm-global-host", (args) => run(join(prefix, "bin/pm"), ["--path", root, "changelog", "corrections", ...args]));
  run("bun", ["add", "--global", "--ignore-scripts", archive, `@unbrained/pm-cli@${pinned}`]);
  await accept("bun-global", (args) => run(join(childEnv.BUN_INSTALL, "bin/pm-changelog"), ["corrections", "--pm-root", root, ...args]));
  await accept("bun-global-host", (args) => run(join(childEnv.BUN_INSTALL, "bin/pm"), ["--path", root, "changelog", "corrections", ...args]));
  for (const manager of ["npm", "bun"]) {
    const cwd = join(scratch, `${manager}-local`); mkdirSync(cwd); writeFileSync(join(cwd, "package.json"), JSON.stringify({ private: true, type: "module" }));
    run(manager, [manager === "npm" ? "install" : "add", "--ignore-scripts", archive, `@unbrained/pm-cli@${pinned}`], cwd);
    await accept(`${manager}-local`, (args) => run(join(cwd, "node_modules/.bin/pm-changelog"), ["corrections", "--pm-root", root, ...args], cwd));
  }
  await accept("npx", (args) => run("npx", ["--yes", "--package", archive, "--package", `@unbrained/pm-cli@${pinned}`, "pm-changelog", "corrections", "--pm-root", root, ...args]));
  await accept("bunx", (args) => run("bun", ["x", "--bun", "--package", archive, "pm-changelog", "corrections", "--pm-root", root, ...args]));
  console.log(JSON.stringify({ installation_modes: 6, launcher_paths: paths, checks, wrong_release_checks: 32, corrections: (await readReleaseCorrectionView(root, "v1", "accept-claim")).chain.length, non_git: true }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
