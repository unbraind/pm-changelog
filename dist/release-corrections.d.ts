import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { CommitWorkspaceTransactionOptions, NotesResult, LogNote, PmReadOutputReceipt } from "@unbrained/pm-cli/sdk";
import type { ReleaseMilestoneStore } from "./milestones.ts";
/** Refusals distinguish bad input, stale targets and cyclic supersession. */
export type ReleaseCorrectionErrorCode = "correction_invalid" | "correction_missing" | "correction_stale" | "correction_conflict" | "correction_cycle" | "correction_limit";
/** Expected failures retain stable codes and safe recovery instructions. */
export declare class ReleaseCorrectionError extends PmCliError {
    /** Stable automation discriminator independent of rendered prose. */
    readonly code: ReleaseCorrectionErrorCode;
    /** Public-safe corrective action for a refused operation. */
    readonly remedy: string;
    /** Preserve expected-error behavior in the extension host and standalone CLI. */
    constructor(code: ReleaseCorrectionErrorCode, remedy: string);
}
/** One append-only assertion about one published item title; prose is preserved exactly. */
export interface ReleaseCorrectionInput {
    schema: 1;
    release: string;
    item: string;
    milestone: string;
    id: string;
    supersedes: string;
    expectedRevision: string;
    wording: string;
    evidence: string[];
}
/** Content revision binds all authored fields, including target and predecessor. */
export interface ReleaseCorrection extends ReleaseCorrectionInput {
    revision: string;
}
/** Current projection never replaces the immutable historical row. */
export interface ReleaseCorrectionView {
    schema: 1;
    release: string;
    item: string;
    milestone: string;
    original: string;
    current: string;
    revision: string;
    chain: ReleaseCorrection[];
    skipped: {
        foreign: number;
        invalid: number;
        unrelated: number;
    };
}
/** Inject a backend milestone store; SDK remains responsible for item persistence. */
export interface ReleaseCorrectionOptions {
    milestones?: ReleaseMilestoneStore;
    author?: string;
    onTransition?: CommitWorkspaceTransactionOptions["onTransition"];
}
/** Share one strict bounded schema between producers, ingestion and persisted record validation. */
export declare function parseReleaseCorrection(value: unknown): ReleaseCorrection;
/** Serialize only schema-verified records; the exact output can be submitted again. */
export declare function formatReleaseCorrection(value: unknown, format?: "json" | "toon"): string;
/** Read the frozen claim and complete native annotations through the supported SDK. */
export declare function readReleaseCorrectionView(pmRoot: string, release: string, item: string, options?: ReleaseCorrectionOptions): Promise<ReleaseCorrectionView>;
/** Consume an SDK completeness receipt before any row can influence a chain. */
declare function requireCompleteNotes(result: Partial<NotesResult> & {
    read_output?: Partial<PmReadOutputReceipt>;
}): LogNote[];
/** Project only owned valid events; a malformed record cannot poison its neighbors. */
declare function projectCorrectionNotes(view: ReleaseCorrectionView, notes: readonly LogNote[]): ReleaseCorrectionView;
/** Revalidate the target or recognize an exact historical replay, never a saved-plan guess. */
declare function checkTarget(view: ReleaseCorrectionView, record: ReleaseCorrection): boolean;
/** Append exactly one linked correction through the core journal and annotation primitive. */
export declare function appendReleaseCorrection(pmRoot: string, input: unknown, options?: ReleaseCorrectionOptions): Promise<{
    changed: boolean;
    correction: ReleaseCorrection;
    view: ReleaseCorrectionView;
}>;
/** Validate all exposed counts and records before producing compact agent output. */
export declare function formatReleaseCorrectionView(view: ReleaseCorrectionView, format?: "json" | "toon"): string;
/** Package-local pure boundary probes; SDK integration tests always use real trackers. */
export declare const releaseCorrectionTestSurface: {
    requireCompleteNotes: typeof requireCompleteNotes;
    projectCorrectionNotes: typeof projectCorrectionNotes;
    checkTarget: typeof checkTarget;
};
export {};
//# sourceMappingURL=release-corrections.d.ts.map