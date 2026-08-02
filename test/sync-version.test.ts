import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const helperPath = resolve(import.meta.dirname, "../scripts/sync-version.ts");

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

test("sync-version stamps the registration and never a decoy in a comment or string", () => {
  const dir = setupTempProject();
  try {
    // Every decoy here defeats a pattern-matching implementation: the help
    // string is the first `version:` in the file, the comment is the only
    // double-quoted one once the registration uses a template literal, and a
    // uniqueness guard would pick the comment. Only the registration property
    // may be rewritten.
    writeFileSync(
      join(dir, "src/extension.ts"),
      [
        'const help = { description: \'pass version: "1.2.3" to pin\' };',
        "export default defineExtension({",
        '  name: "x",',
        "  version: `0.0.0`,",
        "  help,",
        "});",
        '// Release documentation example: version: "do-not-stamp"',
        "",
      ].join("\n"),
      "utf-8"
    );

    execFileSync(process.execPath, [helperPath, "9.9.9"], {
      cwd: dir,
      stdio: "pipe",
      encoding: "utf-8",
    });

    const stamped = readFileSync(join(dir, "src/extension.ts"), "utf-8");
    assert.ok(stamped.includes('version: "9.9.9",'), "the registration property must be stamped");
    assert.ok(
      stamped.includes('description: \'pass version: "1.2.3" to pin\''),
      "the help string must be untouched"
    );
    assert.ok(
      stamped.includes('// Release documentation example: version: "do-not-stamp"'),
      "the comment must be untouched"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync-version refuses an ambiguous registration and leaves both files unchanged", () => {
  const dir = setupTempProject();
  try {
    writeFileSync(
      join(dir, "src/extension.ts"),
      'export default defineExtension({ name: "x", version: "0.0.0", version: "0.0.1" });\n',
      "utf-8"
    );

    const extensionBefore = readFileSync(join(dir, "src/extension.ts"), "utf-8");
    const manifestBefore = readFileSync(join(dir, "manifest.json"), "utf-8");

    assert.throws(() => {
      execFileSync(process.execPath, [helperPath, "9.9.9"], {
        cwd: dir,
        stdio: "pipe",
        encoding: "utf-8",
      });
    }, /declares 2 'version' properties/);

    assert.equal(
      readFileSync(join(dir, "src/extension.ts"), "utf-8"),
      extensionBefore,
      "the extension must be byte-identical after a rejected sync"
    );
    // The manifest is written only after both files validate, so an aborted
    // sync must not leave it bumped while the extension stays behind.
    assert.equal(
      readFileSync(join(dir, "manifest.json"), "utf-8"),
      manifestBefore,
      "the manifest must not be bumped when the extension is rejected"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync-version reports a registration with no version property rather than guessing", () => {
  const dir = setupTempProject();
  try {
    // The decoy is the only `version:` text in the file; a pattern matcher
    // would stamp it.
    writeFileSync(
      join(dir, "src/extension.ts"),
      [
        'export default defineExtension({ name: "x" });',
        '// changelog note: version: "1.0.0" shipped last week',
        "",
      ].join("\n"),
      "utf-8"
    );

    assert.throws(() => {
      execFileSync(process.execPath, [helperPath, "9.9.9"], {
        cwd: dir,
        stdio: "pipe",
        encoding: "utf-8",
      });
    }, /Could not find a 'version' property in the default-exported registration/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
