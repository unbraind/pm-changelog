#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
/**
 * Resolve the version to stamp, from argv or the release job's environment.
 *
 * Throws rather than defaulting, because a silent fallback would stamp an empty
 * or stale version into two tracked files during a release.
 */
function readVersionFromArgv() {
    const fromArg = process.argv[2];
    const fromEnv = process.env["NPM_VERSION"];
    const version = (fromArg ?? fromEnv ?? "").trim();
    if (!version) {
        throw new Error("sync-version requires a version argument or NPM_VERSION env var");
    }
    return version;
}
/** Render the manifest with its version field replaced, preserving every other key. */
function planManifest(manifestPath, version) {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    parsed.version = version;
    return { path: manifestPath, contents: `${JSON.stringify(parsed, null, 2)}\n` };
}
/**
 * Render the extension source with its `version` literal restamped.
 *
 * The match is required to be unique, and both quote styles count toward that
 * uniqueness. An unanchored `version:` pattern that simply replaces the first
 * hit is a known way to silently corrupt a release: once any other
 * `version: "..."` string exists - a flag description, a help example - the
 * release stamps that one instead, and because the damage is written by the
 * release job rather than by a reviewed diff, it survives every review.
 * Counting single-quoted forms too means a decoy cannot make itself the only
 * match and be rewritten in place of the real registration field.
 */
function planExtensionVersion(extensionPath, version) {
    const source = readFileSync(extensionPath, "utf-8");
    const pattern = /version:\s*(?:"[^"]*"|'[^']*')/g;
    const matches = source.match(pattern);
    if (!matches) {
        throw new Error(`Could not find version literal in ${extensionPath}`);
    }
    if (matches.length > 1) {
        throw new Error(`Refusing to stamp ${extensionPath}: found ${matches.length} 'version:' literals ` +
            `(${matches.join(", ")}). Anchor the intended one before releasing.`);
    }
    return { path: extensionPath, contents: source.replace(pattern, `version: "${version}"`) };
}
/**
 * Stamp the release version into the manifest and the extension registration.
 *
 * Both files are read and validated before either is written. Writing as they
 * were validated would let a rejected extension leave `manifest.json` already
 * bumped, so a release that aborted would still have moved one of the two
 * version sources.
 */
function main() {
    const version = readVersionFromArgv();
    const cwd = process.cwd();
    const planned = [
        planManifest(resolve(cwd, "manifest.json"), version),
        planExtensionVersion(resolve(cwd, "src/extension.ts"), version),
    ];
    for (const file of planned) {
        writeFileSync(file.path, file.contents, "utf-8");
    }
    process.stdout.write(`Synced version ${version} into manifest.json and src/extension.ts\n`);
}
main();
//# sourceMappingURL=sync-version.js.map