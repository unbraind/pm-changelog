import type { ChangelogReleaseWindow } from "./types.ts";
/** Inputs for deriving a single release's version, date, and time window.
 * Each `*FromPackage` / `*Tag` flag asks for a value to be discovered from the
 * checkout instead of supplied, which is what lets a release job pass no
 * literal version or dates at all. */
export interface ReleaseContextOptions {
    cwd?: string;
    version?: string;
    versionFromPackage?: boolean;
    /** Stable heading date used only when the requested release has no tag. */
    dateFallback?: string;
    /** Derive the no-tag fallback from a calendar version (`YYYY.M.D`). */
    dateFromVersion?: boolean;
    since?: string;
    sincePreviousTag?: boolean;
    until?: string;
    untilReleaseTag?: boolean;
}
/** Inputs for deriving the full set of release windows from a repo's git tags,
 * used to rebuild an entire changelog history in one pass. `pending*` describes
 * a release being cut right now, whose tag does not exist yet. */
export interface ReleaseTagHistoryOptions {
    cwd?: string;
    tagPattern?: string;
    /**
     * Include release tags that are not reachable from HEAD. Rebases and history
     * rewrites orphan release tags; excluding them collapses their items into the
     * oldest reachable window, silently losing legacy changelog sections. The pm
     * changelog CLI/extension set this to `true` so a full release history is
     * preserved. Defaults to `false` so the exported helper keeps the safe,
     * reachable-only `git tag --merged HEAD` semantics for external callers.
     */
    includeOrphaned?: boolean;
    includeUnreleased?: boolean;
    pendingVersion?: string;
    pendingTimestamp?: string;
}
/** A release tag and the timestamp used to order and date its window. */
export interface ReleaseTag {
    name: string;
    timestamp: string;
    /** Whether this entry represents the release being cut before its tag exists. */
    pending?: boolean;
}
/** Stable identifier for the incomplete-tag-history failure. Callers match on
 * this rather than on message text, so the wording stays free to change. */
export declare const MISSING_TAG_HISTORY_ERROR_CODE = "E_MISSING_TAG_HISTORY";
/**
 * Structured diagnostic raised when tag-derived release windows are requested
 * from a checkout whose git tag history is incomplete. Carries a stable
 * machine-readable `code` plus the recovery commands so agents and CI logs can
 * distinguish "missing git context" from "stale generated content".
 */
export declare class MissingTagHistoryError extends Error {
    /** Machine-readable discriminator, always
     * {@link MISSING_TAG_HISTORY_ERROR_CODE}. */
    readonly code = "E_MISSING_TAG_HISTORY";
    /**
     * Machine-readable list of recovery commands. Each entry is a single
     * independently-executable shell command; consumers run them in the listed
     * order. Entries are deliberately NOT compound `&&` expressions so callers
     * that execute each element discretely (CI bots, agents) still get a valid
     * command. The human-readable `message` may embed the inline `&&` form for
     * copy-paste convenience.
     */
    readonly recoveryCommands: readonly string[];
    /** Build the diagnostic, defaulting to the generic tag-refetch recovery when
     * the caller has nothing more specific to suggest. */
    constructor(message: string, recoveryCommands?: readonly string[]);
}
/** Inputs for the pre-flight check that a checkout can answer tag questions. */
export interface AssertReleaseTagHistoryOptions {
    cwd?: string;
    /**
     * Names of the tag-derived flags/features the caller requested (e.g.
     * `--since-previous-tag`); used only to make the diagnostic name the exact
     * options that cannot be honored.
     */
    requiredBy: string[];
}
/**
 * Fail fast when tag-derived release windows are requested from a checkout
 * with incomplete git tag history.
 *
 * Two checkout states are rejected because they provably omit tag refs the
 * window derivation depends on:
 *   - a shallow clone (even when some tags survive, the ones truncated away
 *     silently collapse the window);
 *   - a full clone configured to exclude tags (`git clone --no-tags` records
 *     `remote.<name>.tagOpt=--no-tags`), regardless of how many tags are
 *     locally present — a tag-excluding checkout that picked up SOME tags
 *     (single-tag fetch, later push) has a partial set that collapses the
 *     previous-tag window just as silently as zero tags would.
 * Continuing in either state would misreport a correct CHANGELOG.md as stale.
 * A full clone with zero tags and NO tag-excluding config is NOT rejected —
 * that is the intentional first-release state, and the existing
 * pending-version / unbounded-window fallbacks for it are preserved unchanged.
 */
export declare function assertReleaseTagHistory(options: AssertReleaseTagHistoryOptions): void;
/** What a checkout could tell us about the release being generated. Every field
 * is optional because each is independently discoverable or absent: an untagged
 * first release resolves a version but no tag, dates, or bounds. */
export interface ReleaseContext {
    version?: string;
    date?: string;
    since?: string;
    until?: string;
    releaseTag?: string;
    previousTag?: string;
}
/**
 * Discover one release's version, date, and time bounds from the checkout.
 *
 * Explicit values always win; the flags only fill gaps. The window is dated
 * from tag commit timestamps rather than from when items were closed, so a
 * regeneration long after the fact reproduces the same boundaries. Requesting
 * any tag-derived bound first asserts the checkout actually has tag history,
 * because a shallow clone would otherwise silently widen the window.
 */
export declare function resolveReleaseContext(options: ReleaseContextOptions): ReleaseContext;
/**
 * Turn a repo's release tags into contiguous, newest-first release windows.
 *
 * Each tagged window runs from the previous tag (exclusive, so a tag's own
 * commit is not claimed by both neighbours) to its own tag, and an open-ended
 * `Unreleased` window leads unless suppressed. A pending version with no tag
 * yet always leads regardless of its display timestamp, and its upper bound
 * remains open so the release being cut owns all work after the previous tag.
 */
export declare function resolveReleaseTagWindows(options?: ReleaseTagHistoryOptions): ChangelogReleaseWindow[];
/**
 * Total deterministic comparator for ReleaseTag pairs. Contract:
 *  1. Valid parsed timestamps sort in descending order (newest first).
 *  2. A tag with a valid (parseable) timestamp sorts before one with an invalid
 *     unparseable timestamp, regardless of name.
 *  3. Two tags with equally-invalid timestamps tie-break by name ascending.
 *
 * This replaces bare `Date.parse(a) - Date.parse(b)` which returns `NaN` when
 * either timestamp is unparseable — and `Array.sort(NaN)` is non-deterministic
 * (the spec says the sort order is implementation-defined when the comparator
 * does not return a total order).
 */
export declare function compareReleaseTags(a: ReleaseTag, b: ReleaseTag): number;
/** Parse one `git tag --format` row, preferring the peeled (annotated) date and
 * dropping rows missing a name or any timestamp. */
export declare function parseTagLine(line: string): ReleaseTag | undefined;
/** Render an arbitrary timestamp as a UTC `YYYY-MM-DD` date, falling back to
 * the first ten characters when the value is not a parseable date so a heading
 * never becomes `Invalid Date`. Exported for direct testing because the
 * fallback is the one path real git-tag output never exercises.
 *
 * @param timestamp - A timestamp string, parseable or not.
 * @returns A `YYYY-MM-DD` date string.
 */
export declare function formatDate(timestamp: string): string;
/** Render a release-tag timestamp as the heading date, preferring the literal
 * leading `YYYY-MM-DD` so a commit's local date (not its UTC instant) heads the
 * release, and falling back to {@link formatDate} when no date prefix is present.
 * Exported for direct testing because the fallback is unreachable through git's
 * `iso-strict` output.
 *
 * @param timestamp - The timestamp string a release tag carries.
 * @returns A `YYYY-MM-DD` heading date.
 */
export declare function formatLocalTimestampDate(timestamp: string): string;
/**
 * Rewrite a UTC-equivalent timestamp to the canonical ISO `Z` form without
 * altering its instant or its UTC date.
 *
 * Non-UTC offsets and unparseable strings are returned verbatim so callers that
 * depend on the local date prefix (such as `formatLocalTimestampDate`) are
 * unaffected. Intentionally narrower than `normalizeTimestamp`, which always
 * converts to UTC and would therefore shift a tag's heading date.
 */
export declare function canonicalizeUtcOffset(value: string): string;
/**
 * Extract the trailing timezone offset of an ISO-8601 / RFC-3339 timestamp:
 * `Z`, `±HH:MM`, or `±HHMM`. Returns `null` when no offset is present (the
 * timestamp is "local" or naively formatted) so the caller can avoid guessing.
 *
 * @param value - A timestamp string that may carry a trailing offset.
 * @returns The offset text (`Z` or `±HH:MM`/`±HHMM`), or `null` when none.
 */
export declare function extractOffset(value: string): string | null;
//# sourceMappingURL=release-context.d.ts.map