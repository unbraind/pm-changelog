/** Exercise alias publication through one packed artifact in real npm and Bun consumers. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PmClient, runInit } from "@unbrained/pm-cli/sdk";
import { initGitFixture } from "../test/git-fixture.ts";

const scratch = mkdtempSync(join(tmpdir(), "pm-stable-review-pack-"));
const repository = resolve(import.meta.dirname, "..");
const pinned = (JSON.parse(readFileSync(join(repository, "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies["@unbrained/pm-cli"];
const childEnv = { PATH: process.env.PATH, HOME: scratch, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", DO_NOT_TRACK: "1", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dirname(scratch), GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-11-07T10:00:00Z", GIT_COMMITTER_DATE: "2026-11-07T10:00:00Z" };
/** Capture installer output and run the packed launchers without inherited credentials. */
function run(binary: string, args: string[], cwd: string): string {
  return execFileSync(binary, args, { cwd, env: childEnv, encoding: "utf8", stdio: "pipe", timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
}
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repository)) as { filename: string }[];
  assert.equal(packed.length, 1);
  const archive = join(scratch, packed[0].filename);
  const sha512 = createHash("sha512").update(readFileSync(archive)).digest("hex");
  for (const installer of ["npm", "bun"]) {
    const cwd = join(scratch, installer);
    const root = join(cwd, ".agents/pm");
    await runInit("stable", { path: root }, { defaults: true, agentGuidance: "skip" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "stable-consumer", version: "2026.11.7-2", type: "module" }));
    run(installer, [installer === "npm" ? "install" : "add", "--ignore-scripts", archive, `@unbrained/pm-cli@${pinned}`], cwd);
    const client = new PmClient({ pmRoot: root, author: "acceptance" });
    for (const [index, release] of ["2026.11.7-2", "2026.11.7", "2026.11.7-rc.1"].entries()) {
      await client.create({ id: `delivered-${index}`, title: `Delivered release ${release}`, type: "Task", status: "closed", closeReason: "Delivered", release, createMode: "progressive", unset: ["parent", "goal", "objective", "sprint"] });
    }
    initGitFixture(cwd);
    run("git", ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], cwd);
    for (const tag of ["v2026.11.7-2", "2026.11.7", "2026.11.7-rc.1"]) run("git", ["tag", tag], cwd);
    const extension = join(root, "extensions/pm-changelog");
    cpSync(join(cwd, "node_modules/pm-changelog"), extension, { recursive: true });
    symlinkSync(join(cwd, "node_modules"), join(extension, "node_modules"), "junction");
    const flags = ["--all-release-tags", "--include-empty", "--no-dependency-updates", "--respect-item-release", "--limit", "1"];
    const cli = join(cwd, "node_modules/pm-changelog/dist/cli.js");
    const pm = join(cwd, "node_modules/@unbrained/pm-cli/dist/cli.js");
    const standalone = [cli, "--pm-root", root, "--pm-bin", pm, ...flags];
    const hosted = [pm, "--path", root, "changelog", "generate", ...flags];
    const sdk = `import { resolveReleaseTagWindows, createChangelog, buildChangelogDocument, createChangelogSummary } from "pm-changelog";
      const options = { items: ["2026.11.7-2", "2026.11.7", "2026.11.7-rc.1"].map(release => ({ id: release, title: release, status: "closed", release })), respectItemRelease: true, includeEmpty: true, dependencyUpdates: false, limit: 1, releaseWindows: resolveReleaseTagWindows({ cwd: process.cwd() }) };
      console.log(JSON.stringify([createChangelog(options).markdown, buildChangelogDocument(options), createChangelogSummary(options)]));`;
    const views = () => [
      run("node", ["--input-type=module", "-e", sdk], cwd),
      run("bun", ["-e", sdk], cwd),
      run("node", [...standalone, "--stdout"], cwd),
      run("bun", [...standalone, "--format", "json"], cwd),
      run("node", [...hosted, "--stdout"], cwd),
      run("node", [...hosted, "--changelog-json", "--json"], cwd),
      run("node", [...hosted, "--summary", "--explain-selection"], cwd),
    ];
    const before = views();
    assert.match(before[2], /## 2026\.11\.7-2/);
    assert.match(before[2], /delivered-0/);
    assert.doesNotMatch(before[2], /delivered-[12]/);
    run("node", [...standalone, "--mode", "replace", "--output", "CHANGELOG.md"], cwd);
    run("git", ["tag", "2026.11.7-2"], cwd);
    assert.deepEqual(views(), before, `${installer} alias publication`);
    run("node", [...standalone, "--mode", "replace", "--output", "CHANGELOG.md", "--check"], cwd);
    run("bun", [...standalone, "--mode", "replace", "--output", "CHANGELOG.md", "--check"], cwd);
    console.log(JSON.stringify({ installer, projections: before.length, alias_invariant: true, node_check: true, bun_check: true, archive_sha512: sha512 }));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
