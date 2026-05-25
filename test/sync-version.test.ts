import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const helperPath = resolve(import.meta.dirname, "../dist/sync-version.js");

function setupTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-sync-"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "x", version: "0.0.0" }, null, 2)}\n`,
    "utf-8"
  );
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify({ name: "x", version: "0.0.0", manifest_version: 2 }, null, 2)}\n`,
    "utf-8"
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src/extension.ts"),
    'export default { name: "x", version: "0.0.0" };\n',
    "utf-8"
  );
  return dir;
}

test("sync-version updates manifest.json and src/extension.ts to the supplied version", () => {
  const dir = setupTempProject();
  try {
    execFileSync(process.execPath, [helperPath, "9.9.9-alpha"], {
      cwd: dir,
      stdio: "pipe",
      encoding: "utf-8",
    });

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as {
      version: string;
    };
    const extensionSource = readFileSync(join(dir, "src/extension.ts"), "utf-8");

    assert.equal(manifest.version, "9.9.9-alpha");
    assert.ok(
      /version:\s*"9\.9\.9-alpha"/.test(extensionSource),
      "extension.ts should contain the new version literal"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync-version honors NPM_VERSION env when no argv is passed", () => {
  const dir = setupTempProject();
  try {
    execFileSync(process.execPath, [helperPath], {
      cwd: dir,
      stdio: "pipe",
      encoding: "utf-8",
      env: { ...process.env, NPM_VERSION: "2026.5.25-1" },
    });

    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as {
      version: string;
    };
    const extensionSource = readFileSync(join(dir, "src/extension.ts"), "utf-8");

    assert.equal(manifest.version, "2026.5.25-1");
    assert.ok(/version:\s*"2026\.5\.25-1"/.test(extensionSource));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync-version exits non-zero when no version is provided", () => {
  const dir = setupTempProject();
  try {
    const env = { ...process.env };
    delete env.NPM_VERSION;
    assert.throws(() => {
      execFileSync(process.execPath, [helperPath], {
        cwd: dir,
        stdio: "pipe",
        encoding: "utf-8",
        env,
      });
    }, /sync-version requires a version argument or NPM_VERSION env var/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
