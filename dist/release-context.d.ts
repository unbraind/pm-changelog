import type { ChangelogReleaseWindow } from "./types.ts";
/** Inputs for deriving a single release's version, date, and time window.
 * Each `*FromPackage` / `*Tag` flag asks for a value to be discovered from the
 * checkout instead of supplied, which is what lets a release job pass no
 * literal version or dates at all. */
export interface ReleaseContextOptions {
    cwd?: string;
    version?: string;
    versionFromPackage?: boolean;
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
 * Each window runs from the previous tag (exclusive, so a tag's own commit is
 * not claimed by both neighbours) to its own tag, and an open-ended
 * `Unreleased` window leads unless suppressed. A pending version with no tag
 * yet is folded in at its sorted position, which is what lets the release being
 * cut appear in the changelog before its tag exists.
 */
export declare function resolveReleaseTagWindows(options?: ReleaseTagHistoryOptions): ChangelogReleaseWindow[];
//# sourceMappingURL=release-context.d.ts.map