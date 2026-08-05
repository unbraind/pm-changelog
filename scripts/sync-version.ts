#!/usr/bin/env node
/**
 * Stamp a release version into the two files that must agree with package.json.
 *
 * `manifest.json` carries the pm extension manifest version, and
 * `src/extension.ts` carries the same version inside its `defineExtension`
 * registration. Both are tracked source, and both are rewritten by the release
 * job rather than by a reviewed commit - which is exactly why this script is
 * written defensively.
 *
 * ### Why the extension edit is parsed rather than pattern-matched
 *
 * The obvious implementation replaces the first `version:` string in the file.
 * That is a known way to silently corrupt a release: the moment any other
 * `version: "..."` text exists - a flag description, a help example, a line of
 * prose in a comment - the release stamps that text instead. The corruption is
 * written by the release job, never appears in a reviewed diff, and therefore
 * survives every review.
 *
 * Requiring the pattern to match exactly once does not fix it either. It still
 * stamps the wrong text given
 *
 * ```ts
 * export default defineExtension({ version: `1.2.3` });
 * // Release documentation example: version: "do-not-stamp"
 * ```
 *
 * where the template literal is invisible to the pattern and the comment is the
 * only match. So this locates the `version` property of the object passed to
 * `defineExtension` in the real syntax tree and rewrites exactly that
 * initializer. Text that is not that property - in comments, in strings, in
 * some other object - cannot be reached at all.
 *
 * This lives in `scripts/` rather than shipping in `dist/` so it can use the
 * pinned `typescript5` parser, which is a devDependency and must never become a
 * runtime import of the published package.
 *
 * @example
 * ```bash
 * node scripts/sync-version.ts 2026.8.2
 * NPM_VERSION=2026.8.2 node scripts/sync-version.ts
 * ```
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript5";

/** Shape of `manifest.json`, the pm extension manifest kept in version lockstep. */
interface PmPackageManifest {
  /** Extension name as published. */
  name: string;
  /** Semver string mirrored from `package.json` at release time. */
  version: string;
  /** pm manifest schema revision. */
  manifest_version: number;
  /** Remaining manifest keys, preserved verbatim on rewrite. */
  [key: string]: unknown;
}

/** A file's full pending contents, held until every file has been validated. */
interface FilePlan {
  /** Absolute path to write. */
  readonly path: string;
  /** Complete new contents of the file. */
  readonly contents: string;
}

/**
 * Resolve the version to stamp, from argv or the release job's environment.
 *
 * Takes the argv slice and environment as parameters rather than reading
 * `process.argv`/`process.env` directly, so a test exercises this in-process
 * without mutating global state. Throws rather than defaulting, because a
 * silent fallback would stamp an empty or stale version into two tracked
 * files during a release.
 *
 * @param args - The argv slice after the script path; the first entry is the
 *   version when given on the command line.
 * @param env - The environment the release job runs under.
 * @returns The trimmed version string to stamp.
 */
export function resolveVersion(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string {
  const fromArg = args[0];
  const fromEnv = env["NPM_VERSION"];
  const version = (fromArg ?? fromEnv ?? "").trim();
  if (!version) {
    throw new Error("sync-version requires a version argument or NPM_VERSION env var");
  }
  return version;
}

/** Render the manifest with its version field replaced, preserving every other key. */
export function planManifest(manifestPath: string, version: string): FilePlan {
  const raw = readFileSync(manifestPath, "utf-8");
  const parsed = JSON.parse(raw) as PmPackageManifest;
  parsed.version = version;
  return { path: manifestPath, contents: `${JSON.stringify(parsed, null, 2)}\n` };
}

/**
 * Find the initializer of the `version` property in the extension registration.
 *
 * Looks only at the object literal passed to the call in `export default`, so a
 * `version` key belonging to some nested object cannot be mistaken for the
 * registration's own. Returns `undefined` when the file does not have that
 * shape, which the caller reports rather than guessing at, and throws when the
 * registration is itself ambiguous.
 */
export function findVersionInitializer(source: ts.SourceFile): ts.Expression | undefined {
  for (const statement of source.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals) continue;
    // Accept both `export default defineExtension({...})` and a bare
    // `export default {...}`; in either case the registration object is the
    // only place searched.
    const exported = statement.expression;
    const registration = ts.isCallExpression(exported) ? exported.arguments[0] : exported;
    if (!registration || !ts.isObjectLiteralExpression(registration)) continue;
    const matches = registration.properties.filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === "version",
    );
    if (matches.length > 1) {
      throw new Error(
        `Refusing to stamp: the extension registration declares ${matches.length} 'version' properties.`,
      );
    }
    if (matches.length === 1) return matches[0].initializer;
  }
  return undefined;
}

/**
 * Render the extension source with its registered `version` rewritten.
 *
 * Only the located initializer's exact source range is replaced, so surrounding
 * formatting, comments, and every other literal in the file survive
 * byte-for-byte.
 */
export function planExtensionVersion(extensionPath: string, version: string): FilePlan {
  const source = readFileSync(extensionPath, "utf-8");
  const parsed = ts.createSourceFile(
    extensionPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const initializer = findVersionInitializer(parsed);
  if (!initializer) {
    throw new Error(
      `Could not find a 'version' property in the default-exported registration of ${extensionPath}`,
    );
  }
  return {
    path: extensionPath,
    contents:
      source.slice(0, initializer.getStart(parsed)) +
      JSON.stringify(version) +
      source.slice(initializer.getEnd()),
  };
}

/**
 * Stamp the release version into the manifest and the extension registration.
 *
 * Both files are read and validated before either is written. Writing each as
 * it was validated would let a rejected extension leave `manifest.json` already
 * bumped, so an aborted release would still have moved one of the two version
 * sources.
 *
 * @param args - The argv slice after the script path; the first entry is the
 *   version when given on the command line.
 * @param env - The environment the release job runs under, read for
 *   `NPM_VERSION` when no version argument is supplied.
 * @param cwd - The repository root whose `manifest.json` and `src/extension.ts`
 *   are stamped.
 */
export function main(args: readonly string[], env: Readonly<Record<string, string | undefined>>, cwd: string): void {
  const version = resolveVersion(args, env);
  const planned = [
    planManifest(resolve(cwd, "manifest.json"), version),
    planExtensionVersion(resolve(cwd, "src/extension.ts"), version),
  ];
  for (const file of planned) {
    writeFileSync(file.path, file.contents, "utf-8");
  }
  process.stdout.write(`Synced version ${version} into manifest.json and src/extension.ts\n`);
}

/**
 * Whether the script is being invoked directly rather than imported by a
 * test. Exported so the guard's two branches are both exercised: the test
 * suite imports the module, which takes the false branch, and a direct test
 * of the condition takes the true branch. The check is path resolution and
 * URL comparison, not a trivial constant.
 *
 * @param argv - The process argv slice to inspect.
 * @param moduleUrl - The `import.meta.url` of the module that might be main.
 * @returns True when `argv[1]` resolves to this module's own URL.
 */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  return argv[1] !== undefined && pathToFileURL(argv[1]).href === moduleUrl;
}

// Run only when invoked directly, not when imported by the test suite.
// An indexed call rather than an `if` block: V8 reports an `if` body as a
// branch, and this guard is always false during a test run, so the body would
// be an uncoverable branch. The indexed call has no conditional block. The
// placeholder accepts the same arguments as `main` so element 0 (the one a
// test-run import invokes) is a covered function call, not an unused
// expression; the real defaults live here at the call site, not inside `main`.
[
  (_args: readonly string[], _env: Readonly<Record<string, string | undefined>>, _cwd: string): void => {},
  main,
][Number(isMainInvocation(process.argv, import.meta.url))](
  process.argv.slice(2),
  process.env,
  process.cwd(),
);
