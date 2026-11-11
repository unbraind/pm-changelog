/** Verify one packed artifact through real npm/Bun consumers and non-Git trackers. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { decode } from "@toon-format/toon";
import { runInit } from "@unbrained/pm-cli/sdk";

const repository = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "pm-markdown-consumers-"));
const pinned = (JSON.parse(readFileSync(join(repository, "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies["@unbrained/pm-cli"];
const env = { PATH: process.env.PATH, HOME: scratch, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull,
  NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", DO_NOT_TRACK: "1", GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: dirname(scratch) };
const example = "    retained code  \n\n# Changelog\n\n~~~~markdown\n# Example title\n## Unreleased\n\nNo changes.\n\n## 1.0.0\n~~~~\n\n";
const history = "## 1.0.0\n\nRetained delivery.  \n";
const existing = example + "## Unreleased\n\nNo changes.\n\n" + history;
const expected = example + history;

/** Run only owned consumers with bounded output and no inherited credentials. */
function run(binary: string, args: string[], cwd: string): string {
  return execFileSync(binary, args, { cwd, env, encoding: "utf8", stdio: "pipe", timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
}

try {
  run("npm", ["run", "build"], repository);
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repository)) as { filename: string }[];
  assert.equal(packed.length, 1);
  const archive = join(scratch, packed[0]!.filename);
  const sha512 = createHash("sha512").update(readFileSync(archive)).digest("hex");
  for (const installer of ["npm", "bun"]) {
    const cwd = join(scratch, installer);
    const root = join(cwd, ".agents/pm");
    await runInit("retention", { path: root }, { defaults: true, agentGuidance: "skip" });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "retention-consumer", type: "module", version: "1.0.0" }));
    run(installer, [installer === "npm" ? "install" : "add", "--ignore-scripts", archive, `@unbrained/pm-cli@${pinned}`], cwd);
    const extension = join(root, "extensions/pm-changelog");
    cpSync(join(cwd, "node_modules/pm-changelog"), extension, { recursive: true });
    symlinkSync(join(cwd, "node_modules"), join(extension, "node_modules"), "junction");
    const output = join(cwd, "CHANGELOG.md");
    const cli = join(cwd, "node_modules/pm-changelog/dist/cli.js");
    const pm = join(cwd, "node_modules/@unbrained/pm-cli/dist/cli.js");
    const flags = ["--mode", "prepend", "--output", output, "--no-dependency-updates"];
    const standalone = [cli, "--pm-root", root, "--pm-bin", pm, ...flags];
    const hosted = ["--path", root, "changelog", "generate", ...flags];
    let checks = 0;
    for (const runtime of ["node", "bun"]) {
      // Public SDK and both installed runtimes must use the packed dist code.
      const sdk = `import assert from "node:assert/strict";
        import { mergeChangelog, writeChangelog } from "pm-changelog";
        import { readFileSync } from "node:fs";
        const expected = ${JSON.stringify(expected)};
        assert.equal(mergeChangelog(${JSON.stringify(existing)}, "# Changelog\\n").markdown, expected);
        const result = writeChangelog({ items: [], mode: "prepend", output: "CHANGELOG.md", dependencyUpdates: false });
        assert.equal(result.markdown, expected);
        assert.equal(readFileSync("CHANGELOG.md", "utf8"), expected);`;
      writeFileSync(output, existing);
      run(runtime, ["--eval", sdk], cwd);
      checks += 2;
      writeFileSync(output, existing);
      run(runtime, standalone, cwd);
      assert.equal(readFileSync(output, "utf8"), expected);
      run(runtime, [...standalone, "--check"], cwd);
      checks += 2;
      for (const json of [false, true]) {
        writeFileSync(output, existing);
        const rendered = run(runtime, [pm, ...(json ? ["--json"] : []), ...hosted], cwd);
        assert.ok(json ? JSON.parse(rendered) : decode(rendered));
        assert.equal(readFileSync(output, "utf8"), expected);
        run(runtime, [pm, ...(json ? ["--json"] : []), ...hosted, "--check"], cwd);
        checks += 2;
      }
      for (const example of [
        "- ```text\n  sample\n  ```", "1. outer\n   > ~~~~text\n   > sample\n   > ~~~~", "> ```text\n> sample",
      ]) {
        const retained = `# Changelog\n\n## 2.0.0\n\n${example}\n\n${history}`;
        const replacement = "# Changelog\n\n## 2.0.0\n\nNo changes.\n";
        const merged = replacement + "\n" + history;
        const consumer = `import assert from "node:assert/strict";
          import { mergeChangelog, writeChangelog } from "pm-changelog";
          assert.equal(mergeChangelog(${JSON.stringify(retained)}, ${JSON.stringify(replacement)}).markdown, ${JSON.stringify(merged)});
          assert.equal(writeChangelog({ items: [], version: "2.0.0", includeEmpty: true, mode: "prepend", output: "CHANGELOG.md", dependencyUpdates: false }).markdown, ${JSON.stringify(merged)});`;
        writeFileSync(output, retained);
        run(runtime, ["--eval", consumer], cwd);
        checks += 2;
        const version = ["--version", "2.0.0", "--include-empty"];
        writeFileSync(output, retained);
        run(runtime, [...standalone, ...version], cwd);
        assert.equal(readFileSync(output, "utf8"), merged);
        run(runtime, [...standalone, ...version, "--check"], cwd);
        checks += 2;
        for (const json of [false, true]) {
          writeFileSync(output, retained);
          const rendered = run(runtime, [pm, ...(json ? ["--json"] : []), ...hosted, "--release-version", "2.0.0", "--include-empty"], cwd);
          assert.ok(json ? JSON.parse(rendered) : decode(rendered));
          assert.equal(readFileSync(output, "utf8"), merged);
          run(runtime, [pm, ...(json ? ["--json"] : []), ...hosted, "--release-version", "2.0.0", "--include-empty", "--check"], cwd);
          checks += 2;
        }
      }
      // Structured generation is intentionally independent of retained Markdown.
      const before = readFileSync(output, "utf8");
      const document = JSON.parse(run(runtime, [...standalone, "--format", "json"], cwd)) as { releases: unknown[] };
      assert.deepEqual(document.releases, []);
      assert.equal(readFileSync(output, "utf8"), before);
      checks++;
    }
    console.log(JSON.stringify({ installer, checks, non_git_tracker: true, archive_sha512: sha512 }));
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
