import type { ChangelogReleaseWindow } from "./types.js";
export interface ReleaseContextOptions {
    cwd?: string;
    version?: string;
    versionFromPackage?: boolean;
    since?: string;
    sincePreviousTag?: boolean;
    until?: string;
    untilReleaseTag?: boolean;
}
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
export declare const MISSING_TAG_HISTORY_ERROR_CODE = "E_MISSING_TAG_HISTORY";
/**
 * Structured diagnostic raised when tag-derived release windows are requested
 * from a checkout whose git tag history is incomplete. Carries a stable
 * machine-readable `code` plus the recovery commands so agents and CI logs can
 * distinguish "missing git context" from "stale generated content".
 */
export declare class MissingTagHistoryError extends Error {
    readonly code = "E_MISSING_TAG_HISTORY";
    readonly recoveryCommands: readonly string[];
    constructor(message: string, recoveryCommands?: readonly string[]);
}
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
 * Only a shallow checkout is rejected: it provably omits tag refs the window
 * derivation depends on (even when some tags survive, the ones truncated away
 * silently collapse the window), so continuing would misreport a correct
 * CHANGELOG.md as stale. A full clone with zero tags is NOT rejected — that is
 * the intentional first-release state, and the existing pending-version /
 * unbounded-window fallbacks for it are preserved unchanged.
 */
export declare function assertReleaseTagHistory(options: AssertReleaseTagHistoryOptions): void;
export interface ReleaseContext {
    version?: string;
    date?: string;
    since?: string;
    until?: string;
    releaseTag?: string;
    previousTag?: string;
}
export declare function resolveReleaseContext(options: ReleaseContextOptions): ReleaseContext;
export declare function resolveReleaseTagWindows(options?: ReleaseTagHistoryOptions): ChangelogReleaseWindow[];
//# sourceMappingURL=release-context.d.ts.map