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
/** Rewrite the manifest's version field, preserving every other key. */
function syncManifest(manifestPath, version) {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    parsed.version = version;
    writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
}
/**
 * Rewrite the `version` literal in the extension's registration object.
 *
 * The match is required to be unique. An unanchored `version:` pattern that
 * simply replaces the first hit is a known way to silently corrupt a release:
 * once any earlier `version: "..."` string exists - a flag description, a help
 * example - the release stamps that string instead, and because the damage is
 * committed by the release job rather than by a reviewed diff, it survives
 * every review. Failing loudly on an ambiguous file is the whole point.
 */
function syncExtensionVersion(extensionPath, version) {
    const source = readFileSync(extensionPath, "utf-8");
    const pattern = /version:\s*"[^"]+"/g;
    const matches = source.match(pattern);
    if (!matches) {
        throw new Error(`Could not find version literal in ${extensionPath}`);
    }
    if (matches.length > 1) {
        throw new Error(`Refusing to stamp ${extensionPath}: found ${matches.length} 'version:' literals ` +
            `(${matches.join(", ")}). Anchor the intended one before releasing.`);
    }
    writeFileSync(extensionPath, source.replace(pattern, `version: "${version}"`), "utf-8");
}
/** Stamp the release version into the manifest and the extension registration. */
function main() {
    const version = readVersionFromArgv();
    const cwd = process.cwd();
    syncManifest(resolve(cwd, "manifest.json"), version);
    syncExtensionVersion(resolve(cwd, "src/extension.ts"), version);
    process.stdout.write(`Synced version ${version} into manifest.json and src/extension.ts\n`);
}
main();
//# sourceMappingURL=sync-version.js.map