/** Execute the workflow's publisher arguments against a real, offline npm dry run. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("the actual release publisher accepts numeric same-day suffixes with npm latest", async (t) => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const invocations = workflow.split("\n").filter((line) => /^\s*npm publish\s/.test(line));
  assert.equal(invocations.length, 1, "one executed npm publisher owns the release dist-tag");
  const args = invocations[0].trim().split(/\s+/).slice(1);
  assert.ok(args.every((arg) => /^[a-zA-Z0-9._=/\-]+$/.test(arg)), "the fixture only executes literal argument tokens");
  const directory = await mkdtemp(join(tmpdir(), "pmc-publish-tag-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = "pm-changelog-offline-publish-fixture";
  const version = "2026.10.19-1";
  await writeFile(join(directory, "package.json"), JSON.stringify({ name, version, description: "Offline publisher acceptance", license: "MIT", files: ["README.md"] }));
  await writeFile(join(directory, "README.md"), "Synthetic package for an offline dry run.\n");
  await writeFile(join(directory, "user.npmrc"), "");
  await writeFile(join(directory, "global.npmrc"), "");
  const result = await promisify(execFile)("npm", [...args, "--dry-run", "--offline"], {
    cwd: directory,
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      npm_config_userconfig: join(directory, "user.npmrc"),
      npm_config_globalconfig: join(directory, "global.npmrc"),
      npm_config_cache: join(directory, "cache"),
      npm_config_registry: "http://127.0.0.1:9",
      npm_config_update_notifier: "false",
      npm_config_audit: "false",
    },
  });
  assert.match(result.stdout, new RegExp(`${name}@${version.replaceAll(".", "\\.")}`));
  assert.match(result.stderr, /tag latest/, "the real client selects the consumer-facing latest tag");
});
