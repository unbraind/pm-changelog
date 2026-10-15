import { SETTINGS_DEFAULTS } from "@unbrained/pm-cli/sdk";
import type { GenerateChangelogOptions, PmItem } from "./types.ts";
/** Immutable Git blob identity and the SDK parser format selected by its path. */
export interface ReleaseItemBlob {
    hash: string;
    format: "toon" | "json_markdown";
    /** Physical type folder retained for historical item links. */
    folder?: string;
}
/**
 * Verify timestamp-derived release placement against the tracked item state
 * in each Git tag. A completion made on an unmerged branch can precede a
 * release cut without belonging to that release. Carry such items forward to
 * the first tag containing their selected status, or to the pending window.
 *
 * Explicit release declarations remain authoritative. Tags predating the
 * tracker retain timestamp placement because their absent tracker cannot
 * prove whether imported historical work shipped. Caller-supplied JSON and
 * non-Git SDK generation can omit this resolver and retain pure generation.
 * The returned map records only corrections and never mutates tracker data.
 */
export declare function resolveGitReleaseMembership(options: GenerateChangelogOptions, pmRoot: string): Promise<ReadonlyMap<string, string | null>>;
/** Verified placement plus immutable prior completion occurrences. */
export interface GitReleaseHistory {
    items: PmItem[];
    releaseMembership: ReadonlyMap<string, string | null>;
}
/** Preserve earlier shipped completions when a canonical item is reopened.
 * Historical copies carry their containing release tag, so ordinary pure
 * generation applies the same status, exclusion, grouping and visibility rules.
 * Current explicit release declarations remain authoritative. */
export declare function resolveGitReleaseHistory(options: GenerateChangelogOptions, pmRoot: string): Promise<GitReleaseHistory>;
/**
 * Decode length-prefixed Git batch blobs with the public SDK item parser.
 * Byte lengths, hashes, separators, and document identities must agree before
 * any status is trusted; a malformed response must fail changelog generation
 * rather than treating a partial read as evidence that work was unreleased.
 */
export declare function parseReleaseItemStatuses(output: Buffer, blobs: ReadonlyMap<string, ReleaseItemBlob>, schema: typeof SETTINGS_DEFAULTS.schema): Map<string, string>;
//# sourceMappingURL=release-membership.d.ts.map