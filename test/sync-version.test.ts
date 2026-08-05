/**
 * Behavioural tests for the release version stamping script.
 *
 * Every case imports the script's exported functions and runs them in-process
 * against a throwaway workspace, because coverage is only attributed to a file
 * the parent process loads - spawning the script as a child process would
 * exercise the same behaviour but report zero percent of it. The helpers
 * (`resolveVersion`, `planManifest`, `planExtensionVersion`, `main`) are the
 * real release-time code paths; `main` writes the same files and emits the same
 * stdout the CLI always has, so the in-process call preserves the contract.
 */
import { describe, it } from "node:test";
import { equal, match, ok, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript5";

import {
  findVersionInitializer,
  isMainInvocation,
  main,
  planExtensionVersion,
  planManifest,
  resolveVersion,
} from "../scripts/sync-version.ts";

/** Absolute path to the script under test, used to build a `file://` module URL. */
const SCRIPT_PATH = resolve(import.meta.dirname, "..", "scripts", "sync-version.ts");

/**
 * Build a throwaway project mirroring the real release layout.
 *
 * `manifest.json` and `src/extension.ts` are the two tracked files
 * `sync-version` rewrites, so a faithful fixture carries both plus a
 * `package.json` for completeness.
 */
function setupTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-sync-"));
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: "x", version: "0.0.0" }, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(
    join(dir, "manifest.json"),
    `${JSON.stringify({ name: "x", version: "0.0.0", manifest_version: 2 }, null, 2)}\n`,
    "utf-8",
  );
  mkdirSync(join(dir, "src"));
  writeFileSync(
    join(dir, "src/extension.ts"),
    'export default { name: "x", version: "0.0.0" };\n',
    "utf-8",
  );
  return dir;
}

/** Capture `process.stdout.write` for the duration of `fn`, returning the bytes. */
function captureStdout(fn: () => void): string {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

describe("sync-version: resolveVersion", () => {
  it("prefers the argv version over the environment", () => {
    equal(resolveVersion(["1.2.3"], { NPM_VERSION: "9.9.9" }), "1.2.3");
  });

  it("falls back to NPM_VERSION when no argv version is given", () => {
    equal(resolveVersion([], { NPM_VERSION: "2026.5.25-1" }), "2026.5.25-1");
  });

  it("throws when neither argv nor environment supplies a version", () => {
    throws(
      () => resolveVersion([], {}),
      /sync-version requires a version argument or NPM_VERSION env var/,
    );
  });

  it("trims surrounding whitespace from the resolved version", () => {
    equal(resolveVersion(["  1.2.3  "], {}), "1.2.3");
  });
});

describe("sync-version: planManifest", () => {
  it("replaces the version field and preserves every other key", () => {
    const dir = setupTempProject();
    try {
      const plan = planManifest(join(dir, "manifest.json"), "7.7.7");
      const reparsed = JSON.parse(plan.contents) as { version: string; name: string; manifest_version: number };
      equal(reparsed.version, "7.7.7");
      equal(reparsed.name, "x");
      equal(reparsed.manifest_version, 2);
      ok(plan.contents.endsWith("\n"), "the manifest keeps its trailing newline");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sync-version: planExtensionVersion and findVersionInitializer", () => {
  it("stamps the registration property and never a decoy in a comment or string", () => {
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
        "utf-8",
      );

      const plan = planExtensionVersion(join(dir, "src/extension.ts"), "9.9.9");
      ok(plan.contents.includes('version: "9.9.9",'), "the registration property must be stamped");
      ok(
        plan.contents.includes('description: \'pass version: "1.2.3" to pin\''),
        "the help string must be untouched",
      );
      ok(
        plan.contents.includes('// Release documentation example: version: "do-not-stamp"'),
        "the comment must be untouched",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an ambiguous registration with two version properties", () => {
    const dir = setupTempProject();
    try {
      writeFileSync(
        join(dir, "src/extension.ts"),
        'export default defineExtension({ name: "x", version: "0.0.0", version: "0.0.1" });\n',
        "utf-8",
      );
      throws(
        () => planExtensionVersion(join(dir, "src/extension.ts"), "9.9.9"),
        /declares 2 'version' properties/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a registration with no version property rather than guessing", () => {
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
        "utf-8",
      );
      throws(
        () => planExtensionVersion(join(dir, "src/extension.ts"), "9.9.9"),
        /Could not find a 'version' property in the default-exported registration/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sync-version: findVersionInitializer branches", () => {
  /** Parse a fixture string into a SourceFile the way the script does. */
  function parse(text: string): ts.SourceFile {
    return ts.createSourceFile("ext.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  }

  it("finds the version initializer in a bare object-literal default export", () => {
    // The non-call arm of the `isCallExpression` ternary: `export default { ... }`
    // resolves to the object literal itself.
    const source = parse('export default { name: "x", version: "0.0.0" };\n');
    const init = findVersionInitializer(source);
    ok(init !== undefined, "the object-literal registration's version must be found");
  });

  it("matches a version property whose name is a string literal rather than an identifier", () => {
    // The `isIdentifier || isStringLiteral` arm of the property filter: a
    // quoted key (`"version": ...`) is a StringLiteral name, so the
    // isIdentifier short-circuit is not taken and isStringLiteral is evaluated.
    const source = parse('export default defineExtension({ name: "x", "version": "0.0.0" });\n');
    const init = findVersionInitializer(source);
    ok(init !== undefined, "the quoted-key version property must be matched");
  });

  it("continues past a call with no registration argument", () => {
    // `export default defineExtension()` - the call's argument list is empty,
    // so `registration` is undefined and the `!registration` arm skips it.
    const source = parse("export default defineExtension();\n");
    equal(findVersionInitializer(source), undefined);
  });

  it("continues past a default export that is not an object literal", () => {
    // `export default "banner"` - exported is a string literal, so the
    // `!ts.isObjectLiteralExpression(registration)` arm skips it.
    const source = parse('export default "banner";\n');
    equal(findVersionInitializer(source), undefined);
  });

  it("skips an `export =` assignment", () => {
    // `isExportEquals` arm: `export = { ... }` is the CommonJS-style form and
    // must not be treated as the registration object.
    const source = parse('export = { version: "0.0.0" };\n');
    equal(findVersionInitializer(source), undefined);
  });

  it("returns undefined when the file has no default export at all", () => {
    const source = parse("export const X = 1;\n");
    equal(findVersionInitializer(source), undefined);
  });
});

describe("sync-version: main", () => {
  it("updates manifest.json and src/extension.ts to the supplied version", () => {
    const dir = setupTempProject();
    try {
      const stdout = captureStdout(() => main(["9.9.9-alpha"], {}, dir));

      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as {
        version: string;
      };
      const extensionSource = readFileSync(join(dir, "src/extension.ts"), "utf-8");

      equal(manifest.version, "9.9.9-alpha");
      ok(
        /version:\s*"9\.9\.9-alpha"/.test(extensionSource),
        "extension.ts should contain the new version literal",
      );
      match(stdout, /Synced version 9\.9\.9-alpha into manifest\.json and src\/extension\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors NPM_VERSION env when no argv is passed", () => {
    const dir = setupTempProject();
    try {
      captureStdout(() => main([], { NPM_VERSION: "2026.5.25-1" }, dir));

      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as {
        version: string;
      };
      const extensionSource = readFileSync(join(dir, "src/extension.ts"), "utf-8");

      equal(manifest.version, "2026.5.25-1");
      ok(/version:\s*"2026\.5\.25-1"/.test(extensionSource));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when no version is provided", () => {
    const dir = setupTempProject();
    try {
      throws(
        () => main([], {}, dir),
        /sync-version requires a version argument or NPM_VERSION env var/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves both files unchanged when the extension is rejected", () => {
    const dir = setupTempProject();
    try {
      writeFileSync(
        join(dir, "src/extension.ts"),
        'export default defineExtension({ name: "x", version: "0.0.0", version: "0.0.1" });\n',
        "utf-8",
      );

      const extensionBefore = readFileSync(join(dir, "src/extension.ts"), "utf-8");
      const manifestBefore = readFileSync(join(dir, "manifest.json"), "utf-8");

      throws(
        () => main(["9.9.9"], {}, dir),
        /declares 2 'version' properties/,
      );

      // The manifest is written only after both files validate, so an aborted
      // sync must not leave it bumped while the extension stays behind.
      equal(
        readFileSync(join(dir, "src/extension.ts"), "utf-8"),
        extensionBefore,
        "the extension must be byte-identical after a rejected sync",
      );
      equal(
        readFileSync(join(dir, "manifest.json"), "utf-8"),
        manifestBefore,
        "the manifest must not be bumped when the extension is rejected",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sync-version: CLI guard", () => {
  it("isMainInvocation is true for the module's own path and false otherwise", () => {
    const url = pathToFileURL(SCRIPT_PATH).href;
    equal(isMainInvocation(["node", SCRIPT_PATH], url), true);
    equal(isMainInvocation(["node", "/tmp/other.ts"], url), false);
    equal(isMainInvocation(["node"], url), false);
  });
});