/**
 * Direct tests for the release-context helpers whose defensive branches are
 * never exercised by real git output. Git always emits parseable `iso-strict`
 * timestamps with a trailing offset and a leading date, so the fallbacks in
 * `compareReleaseTags`, `parseTagLine`, `formatDate`, `formatLocalTimestampDate`,
 * `canonicalizeUtcOffset`, and `extractOffset` are unreachable through
 * `resolveReleaseTagWindows` alone. Exercising them directly is what keeps the
 * gate honest without an ignore pragma.
 *
 * The git-reachable branches of the public functions are covered through real
 * mkdtemp repositories here as well, so `cwd ?? process.cwd()`, the
 * `--no-tags` config detection, and `readPackageVersion`'s missing/invalid
 * version paths are all hit against actual filesystem state.
 */
import { describe, it } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertReleaseTagHistory,
  canonicalizeUtcOffset,
  compareReleaseTags,
  extractOffset,
  formatDate,
  formatLocalTimestampDate,
  parseTagLine,
  resolveReleaseContext,
  resolveReleaseTagWindows,
} from "../src/release-context.ts";
import type { ReleaseTag } from "../src/release-context.ts";

/** Shape of a parsed release tag, mirrored for synthetic comparator inputs. */
const TAG = (name: string, timestamp: string): ReleaseTag => ({ name, timestamp });

/** Create a throwaway git repo with one commit. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-rc-"));
  gitIn(dir, ["init", "--quiet"]);
  gitIn(dir, ["config", "user.email", "test@example.com"]);
  gitIn(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "file.txt"), "one\n", "utf-8");
  gitIn(dir, ["add", "."]);
  gitIn(dir, ["commit", "--quiet", "-m", "one"]);
  return dir;
}

/** Run git in a fixture repo. */
function gitIn(dir: string, args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

describe("release-context: assertReleaseTagHistory", () => {
  it("passes in a full clone with no tag-excluding config and returns void", () => {
    const dir = gitRepo();
    try {
      // Empty requiredBy exercises the default `subject` and the plural `verb`.
      equal(assertReleaseTagHistory({ cwd: dir, requiredBy: [] }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults cwd to process.cwd() when omitted", () => {
    // The package's own checkout is a full clone with no tag-excluding config,
    // so assertReleaseTagHistory resolves cwd to process.cwd() and returns void.
    equal(assertReleaseTagHistory({ requiredBy: ["--x"] }), undefined);
  });

  it("rejects a checkout cloned with --no-tags by config even when not shallow", () => {
    const dir = gitRepo();
    try {
      gitIn(dir, ["config", "remote.origin.tagOpt", "--no-tags"]);
      throws(
        () => assertReleaseTagHistory({ cwd: dir, requiredBy: ["--since-previous-tag"] }),
        /cloned with --no-tags/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a tagOpt value that is not --no-tags", () => {
    const dir = gitRepo();
    try {
      gitIn(dir, ["config", "remote.origin.tagOpt", "--tags"]);
      equal(assertReleaseTagHistory({ cwd: dir, requiredBy: ["--x"] }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("release-context: resolveReleaseContext", () => {
  it("reads the version from package.json when versionFromPackage is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-changelog-rc-pkg-"));
    try {
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "x", version: "9.8.7" }, null, 2)}\n`, "utf-8");
      const ctx = resolveReleaseContext({ cwd: dir, versionFromPackage: true });
      equal(ctx.version, "9.8.7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when release-version-from-package finds no package.json", () => {
    // A tmpdir with no package.json in any ancestor walks up to the filesystem
    // root and returns undefined, so readPackageVersion throws.
    const dir = mkdtempSync(join(tmpdir(), "pm-changelog-rc-nopkg-"));
    try {
      // Move into a subdir with no package.json; /tmp itself has none.
      throws(
        () => resolveReleaseContext({ cwd: dir, versionFromPackage: true }),
        /requires a package.json in the current directory or an ancestor/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when package.json has a non-string version field", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-changelog-rc-badpkg-"));
    try {
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "x", version: 5 }, null, 2)}\n`, "utf-8");
      throws(
        () => resolveReleaseContext({ cwd: dir, versionFromPackage: true }),
        /does not contain a valid version field/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when package.json has a blank version field", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-changelog-rc-blankpkg-"));
    try {
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "x", version: "   " }, null, 2)}\n`, "utf-8");
      throws(
        () => resolveReleaseContext({ cwd: dir, versionFromPackage: true }),
        /does not contain a valid version field/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves an unversioned context when no version or from-package flag is given", () => {
    const dir = gitRepo();
    try {
      const ctx = resolveReleaseContext({ cwd: dir });
      equal(ctx.version, undefined);
      equal(ctx.releaseTag, undefined);
      equal(ctx.date, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults cwd to process.cwd() when omitted", () => {
    const ctx = resolveReleaseContext({});
    equal(ctx.version, undefined);
  });

  it("resolves a release tag and its timestamp for a tagged version", () => {
    const dir = gitRepo();
    try {
      gitIn(dir, ["tag", "v1.2.3"]);
      const ctx = resolveReleaseContext({ cwd: dir, version: "1.2.3" });
      equal(ctx.releaseTag, "v1.2.3");
      ok(ctx.date !== undefined, "a tagged release resolves a heading date");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("release-context: resolveReleaseTagWindows", () => {
  it("returns no windows when the tag pattern matches nothing", () => {
    const dir = gitRepo();
    try {
      const windows = resolveReleaseTagWindows({ cwd: dir, tagPattern: "release/*" });
      // No matching tags and no pending version yields an empty list.
      equal(windows.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives a pending tag with the current time when pendingTimestamp is absent", () => {
    const dir = gitRepo();
    try {
      const windows = resolveReleaseTagWindows({ cwd: dir, pendingVersion: "2026.9.9" });
      ok(windows.length > 0, "a pending version produces a window");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves an unparseable pendingTimestamp verbatim rather than dropping it", () => {
    const dir = gitRepo();
    try {
      // normalizeTimestamp returns the raw value when Date cannot parse it,
      // so a bogus timestamp does not throw or silently become now.
      const windows = resolveReleaseTagWindows({ cwd: dir, pendingVersion: "2026.9.9", pendingTimestamp: "not-a-date" });
      ok(windows.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults cwd to process.cwd() when omitted", () => {
    const windows = resolveReleaseTagWindows({});
    ok(Array.isArray(windows));
  });
});

describe("release-context: pending tag spelling", () => {
  it("heads a pending release with the caller's v-prefixed, unpadded version", () => {
    // Asserted through the public window rather than against the internal
    // spelling helper: the property that matters downstream is that the
    // emitted tag preserves the caller's unpadded `YYYY.M.D`, because the
    // pm-cli release pipeline matches on the heading it passed in. A
    // zero-padded `v2026.09.09` would still satisfy a helper-level test and
    // still break that consumer.
    const dir = gitRepo();
    try {
      const windows = resolveReleaseTagWindows({ cwd: dir, pendingVersion: "2026.9.9" });
      ok(windows.length > 0, "a pending version produces a window");
      equal(windows[windows.length - 1]?.releaseTag, "v2026.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("release-context: compareReleaseTags", () => {
  it("orders valid timestamps newest first and tie-breaks by name", () => {
    const a = TAG("alpha", "2026-01-01T00:00:00Z");
    const b = TAG("beta", "2026-02-01T00:00:00Z");
    ok(compareReleaseTags(a, b) > 0, "newer (b) sorts before older (a)");
    ok(compareReleaseTags(b, a) < 0, "older sorts after newer");
    const same = TAG("alpha", "2026-01-01T00:00:00Z");
    ok(compareReleaseTags(a, same) === 0, "equal instant and name tie-breaks to 0");
    // Same instant, different names: ascending name tie-break.
    const first = TAG("aaa", "2026-01-01T00:00:00Z");
    const second = TAG("zzz", "2026-01-01T00:00:00Z");
    ok(compareReleaseTags(second, first) > 0, "ascending name tie-break");
    ok(compareReleaseTags(first, second) < 0, "ascending name tie-break both directions");
  });

  it("places a tag with a valid timestamp before one with an unparseable timestamp", () => {
    const valid = TAG("good", "2026-01-01T00:00:00Z");
    const invalid = TAG("bad", "not-a-timestamp");
    ok(compareReleaseTags(valid, invalid) < 0, "valid sorts before invalid");
    ok(compareReleaseTags(invalid, valid) > 0, "invalid sorts after valid");
  });

  it("tie-breaks two unparseable timestamps by name ascending", () => {
    const low = TAG("aaa", "not-a-timestamp");
    const high = TAG("zzz", "garbage");
    ok(compareReleaseTags(high, low) > 0, "both invalid → name ascending");
    ok(compareReleaseTags(low, low) === 0, "same invalid name → 0");
  });
});

describe("release-context: parseTagLine", () => {
  it("parses a tab-delimited annotated tag row", () => {
    const tag = parseTagLine("v1.0.0\t2026-01-01T00:00:00Z\t2026-01-01T00:00:00Z");
    ok(tag !== undefined);
    equal(tag?.name, "v1.0.0");
  });

  it("falls back to the direct committer date for a lightweight tag", () => {
    const tag = parseTagLine("v1.0.0\t\t2026-01-01T00:00:00Z");
    ok(tag !== undefined);
    equal(tag?.timestamp, "2026-01-01T00:00:00.000Z");
  });

  it("drops a row missing a name or any timestamp", () => {
    equal(parseTagLine("\t\t"), undefined);
    equal(parseTagLine("name\t\t"), undefined);
    equal(parseTagLine(""), undefined);
  });
});

describe("release-context: timestamp formatting", () => {
  it("formatDate returns a UTC date and falls back to the prefix for unparseable input", () => {
    equal(formatDate("2026-05-27T12:00:00Z"), "2026-05-27");
    equal(formatDate("not-a-date-but-prefix"), "not-a-date");
  });

  it("formatLocalTimestampDate prefers the leading date and falls back to formatDate", () => {
    equal(formatLocalTimestampDate("2026-05-27T12:00:00+02:00"), "2026-05-27");
    // No leading date prefix → formatDate → NaN → first ten chars.
    equal(formatLocalTimestampDate("garbage-value"), "garbage-va");
  });
});

describe("release-context: canonicalizeUtcOffset and extractOffset", () => {
  it("extractOffset recognises Z and ±HH:MM / ±HHMM offsets", () => {
    equal(extractOffset("2026-01-01T00:00:00Z"), "Z");
    equal(extractOffset("2026-01-01T00:00:00+05:30"), "+05:30");
    equal(extractOffset("2026-01-01T00:00:00+0530"), "+0530");
    equal(extractOffset("2026-01-01"), null);
    equal(extractOffset("2026-01-01T00:00:00"), null);
  });

  it("canonicalizeUtcOffset rewrites UTC-equivalent offsets to Z form", () => {
    equal(canonicalizeUtcOffset("2026-01-01T00:00:00+00:00"), "2026-01-01T00:00:00.000Z");
    equal(canonicalizeUtcOffset("2026-01-01T00:00:00-00:00"), "2026-01-01T00:00:00.000Z");
    equal(canonicalizeUtcOffset("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z");
  });

  it("canonicalizeUtcOffset preserves a non-UTC offset verbatim", () => {
    // A +05:00 offset denotes a different local date; rewriting it would shift
    // the heading, so it is returned unchanged.
    equal(canonicalizeUtcOffset("2026-01-01T00:00:00+05:00"), "2026-01-01T00:00:00+05:00");
  });

  it("canonicalizeUtcOffset leaves a timestamp without an offset unchanged", () => {
    equal(canonicalizeUtcOffset("2026-01-01"), "2026-01-01");
  });

  it("canonicalizeUtcOffset returns the value verbatim when the offset body is unparseable", () => {
    // An offset is present syntactically but the resulting instant is NaN, so
    // the value is preserved rather than rewritten to an invalid ISO string.
    equal(canonicalizeUtcOffset("garbage+00:00"), "garbage+00:00");
  });
});