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
import { deepEqual, equal, ok, throws } from "node:assert/strict";
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

/** Create a throwaway git repo whose single commit carries a fixed date, so a
 * tag placed on it renders a deterministic heading date. */
function gitRepoAtDate(date: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pm-changelog-rc-date-"));
  gitIn(dir, ["init", "--quiet"]);
  gitIn(dir, ["config", "user.email", "test@example.com"]);
  gitIn(dir, ["config", "user.name", "Test"]);
  commitDated(dir, date);
  return dir;
}

/** Commit the working tree with a fixed author/committer date so tags placed
 * on the commit render deterministic heading dates. */
function commitDated(dir: string, date: string): void {
  writeFileSync(join(dir, "file.txt"), `${date}\n`, "utf-8");
  gitIn(dir, ["add", "."]);
  execFileSync("git", ["commit", "--quiet", "-m", "dated"], {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
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

  it("resolves a package version even when no matching git tag exists yet", () => {
    // Regression for the release-time condition: the daily release workflow
    // bumps package.json on disk and runs the test suite BEFORE the matching
    // git tag is pushed, so resolveReleaseContext must return the in-flight
    // package version rather than undefined or the newest existing tag. The
    // fixture carries an older release tag to prove the resolution ignores
    // tags that do not match the bumped version instead of grabbing the
    // newest one -- the exact state that made a frozen-literal assertion fail
    // on release day.
    const dir = gitRepo();
    try {
      gitIn(dir, ["tag", "v2026.8.7"]);
      writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "x", version: "2026.8.9" }, null, 2)}\n`, "utf-8");
      const ctx = resolveReleaseContext({ cwd: dir, versionFromPackage: true });
      equal(ctx.version, "2026.8.9");
      equal(ctx.releaseTag, undefined, "an untagged in-flight version resolves no release tag");
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

describe("release-context: pendingRelease suppression", () => {
  it("restores the leading Unreleased window for a never-released package version", () => {
    // The pm-vcs/pm-rl shape: zero release tags and a package.json version that
    // has never been released or tagged. The version is a placeholder, not a
    // release being cut, so `pendingRelease: false` must suppress the pending
    // window and keep the leading Unreleased window instead of a heading that
    // asserts a release that never happened (the 2026.8.30 regression).
    const dir = gitRepo();
    try {
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify({ name: "pm-vcs-fixture", version: "2026.7.30" }, null, 2)}\n`,
        "utf-8",
      );
      const version = resolveReleaseContext({ cwd: dir, versionFromPackage: true }).version;
      equal(version, "2026.7.30");
      // Without the flag the pending window leads — the release-run shape that
      // PR #170 established and that must keep holding for real release jobs.
      const cutting = resolveReleaseTagWindows({
        cwd: dir,
        pendingVersion: version,
        pendingTimestamp: "2026-07-30T00:00:00Z",
      });
      equal(cutting.length, 1);
      equal(cutting[0]?.heading, "2026.7.30 - 2026-07-30");
      equal(cutting[0]?.until, undefined, "the pending window stays open through its release commit");
      // With the flag the placeholder version claims nothing: one open-ended
      // Unreleased window owns all work, exactly as before 2026.8.30.
      const suppressed = resolveReleaseTagWindows({
        cwd: dir,
        pendingVersion: version,
        pendingTimestamp: "2026-07-30T00:00:00Z",
        pendingRelease: false,
      });
      equal(suppressed.length, 1);
      equal(suppressed[0]?.heading, "Unreleased");
      equal(suppressed[0]?.since, undefined, "nothing was ever released, so Unreleased is unbounded");
      equal(suppressed[0]?.until, undefined);
      equal(suppressed[0]?.releaseTag, undefined, "no fabricated release tag survives suppression");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a pending window but keeps tagged windows, and is a no-op once the version is tagged", () => {
    const dir = gitRepoAtDate("2026-05-01T12:00:00Z");
    try {
      gitIn(dir, ["tag", "v2026.5.1"]);
      const base = { cwd: dir, pendingVersion: "2026.6.1", pendingTimestamp: "2026-06-01T12:00:00Z" } as const;
      // Without the flag the pending release leads and Unreleased is suppressed
      // (PR #170: the release being cut owns all work after the previous tag).
      const cutting = resolveReleaseTagWindows(base);
      equal(cutting[0]?.heading, "2026.6.1 - 2026-06-01");
      ok(!cutting.some((window) => window.heading === "Unreleased"));
      // With the flag the pending window disappears and the ordinary tagged
      // history returns, Unreleased leading — the pre-pending shape.
      const suppressed = resolveReleaseTagWindows({ ...base, pendingRelease: false });
      equal(suppressed.length, 2);
      equal(suppressed[0]?.heading, "Unreleased");
      equal(suppressed[1]?.heading, "2026.5.1 - 2026-05-01");
      ok(!suppressed.some((window) => window.heading.startsWith("2026.6.1")));

      // Once the version is tagged no pending release exists to suppress, so
      // the flag must be a byte-identical no-op — the healthy-repo guarantee
      // that the 19 released fleet packages see no change from this flag.
      commitDated(dir, "2026-06-01T12:00:00Z");
      gitIn(dir, ["tag", "v2026.6.1"]);
      const released = resolveReleaseTagWindows(base);
      deepEqual(resolveReleaseTagWindows({ ...base, pendingRelease: false }), released);
      equal(released.length, 3);
      equal(released[0]?.heading, "Unreleased");
      equal(released[1]?.heading, "2026.6.1 - 2026-06-01");
      equal(released[2]?.heading, "2026.5.1 - 2026-05-01");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns no windows when suppression coincides with includeUnreleased false", () => {
    const dir = gitRepo();
    try {
      // The caller both suppressed the pending release and asked for no
      // Unreleased window: zero tags leave nothing to render, and the empty
      // list is the honest answer rather than a fabricated heading.
      const windows = resolveReleaseTagWindows({
        cwd: dir,
        pendingVersion: "2026.7.30",
        pendingTimestamp: "2026-07-30T00:00:00Z",
        pendingRelease: false,
        includeUnreleased: false,
      });
      equal(windows.length, 0);
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