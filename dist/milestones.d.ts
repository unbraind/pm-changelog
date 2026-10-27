import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { RuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import type { ChangelogReleaseWindow, PmItem } from "./types.ts";
/** Stable refusal identifiers for automation and recovery. */
export type ReleaseMilestoneErrorCode = "milestone_invalid" | "milestone_membership_changed" | "milestone_missing" | "milestone_storage" | "milestone_options";
/** A recoverable release-source failure, shared by CLI and SDK callers. */
export declare class ReleaseMilestoneError extends PmCliError {
    /** Machine-readable refusal discriminator for retry policy. */
    readonly code: ReleaseMilestoneErrorCode;
    /** Recovery action safe to show in compact CLI error output. */
    readonly remedy: string;
    /** Retain a stable code and actionable remedy without exposing backend paths. */
    constructor(code: ReleaseMilestoneErrorCode, message: string, remedy: string);
}
/** Complete backend read captured at a single logical tracker revision. */
export interface TrackerReleaseSnapshot {
    readonly capturedAt: string;
    readonly items: readonly PmItem[];
    /** SDK-classified done-role IDs at capture time; absent adapters use SDK defaults. */
    readonly doneItemIds?: readonly string[];
}
/** Content-verified, immutable named boundary and its exact tracker membership. */
export interface ReleaseMilestone extends TrackerReleaseSnapshot {
    readonly schema: 1 | 2;
    readonly name: string;
    readonly query: string;
    readonly fingerprint: string;
}
/** Backend adapter: publish atomically refuses replacement and non-monotonic capture times. */
export interface ReleaseMilestoneStore {
    read(name: string): Promise<unknown | undefined>;
    publish(name: string, milestone: ReleaseMilestone): Promise<boolean>;
    names(): Promise<string[]>;
}
/** Validate unknown persisted data before it can affect release attribution. */
export declare function parseReleaseMilestone(value: unknown): ReleaseMilestone;
/** Freeze a named release, refusing attempts to change its existing membership. */
export declare function createReleaseMilestone(store: ReleaseMilestoneStore, name: string, snapshot: TrackerReleaseSnapshot, query?: string): Promise<ReleaseMilestone>;
/** Read all named boundaries, verifying identities instead of trusting backend rows. */
export declare function readReleaseMilestones(store: ReleaseMilestoneStore): Promise<ReleaseMilestone[]>;
/** Exact owning boundary and original row of an item's first done-role capture. */
export interface TrackerReleaseClaim {
    readonly milestone: ReleaseMilestone;
    readonly item: PmItem;
}
/** Verify the entire catalog and select first publication independently of names or input order. */
export declare function resolveTrackerReleaseLedger(milestones: readonly ReleaseMilestone[], _registry?: RuntimeStatusRegistry): {
    ordered: ReleaseMilestone[];
    claims: ReadonlyMap<string, TrackerReleaseClaim>;
};
/** Attribute each item to its first done-role capture, preserving the frozen row.
 * Active, blocked and canceled captures never reserve membership. Later edits,
 * reopenings and recaptures cannot rewrite an earlier published claim. */
export declare function resolveTrackerReleaseHistory(milestones: readonly ReleaseMilestone[], currentItems: readonly PmItem[], registry?: RuntimeStatusRegistry): {
    items: PmItem[];
    releaseWindows: ChangelogReleaseWindow[];
    releaseMembership: ReadonlyMap<string, string>;
    statusSelection: ReadonlyMap<string, boolean>;
};
/** Fail closed on options that would replace or reinterpret frozen boundaries. */
export declare function assertTrackerMilestoneOptions(conflicts: readonly unknown[]): void;
/** Capture a certified full tracker read through the pinned public SDK, without git. */
export declare function readTrackerReleaseSnapshot(pmRoot: string): Promise<TrackerReleaseSnapshot>;
/** Filesystem implementation with atomic no-replace publication for concurrent writers. */
export declare class DirectoryReleaseMilestoneStore implements ReleaseMilestoneStore {
    /** Tracker-relative release records resolved against the supplied root. */
    readonly directory: string;
    /** Scope release records to a tracker-owned, portable directory. */
    constructor(pmRoot: string);
    /** Load one snapshot without converting missing records into empty releases. */
    read(name: string): Promise<unknown | undefined>;
    /** Flush file data before no-replace publication, then flush the directory entry. */
    publish(name: string, milestone: ReleaseMilestone): Promise<boolean>;
    /** Enumerate committed JSON records; incomplete temporary files are invisible. */
    names(): Promise<string[]>;
}
//# sourceMappingURL=milestones.d.ts.map