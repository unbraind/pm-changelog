import type { ChangelogStatusContext, PmItem } from "./types.ts";
/** Resolve a status token identically on both sides of explicit selection comparisons. */
export declare function normalizeChangelogStatus(value: unknown, context: ChangelogStatusContext): string;
/** SDK default selection follows configured done roles, never status-name guesses. */
export declare function defaultDoneStatuses(context: ChangelogStatusContext): readonly string[];
/** Frozen capture meaning wins over current roles; live rows use the SDK registry. */
export declare function isDoneStatus(item: PmItem, context: ChangelogStatusContext): boolean;
/** Explicit non-change dispositions override links and old repair evidence. */
export declare function isNonChangeClosure(item: PmItem, context?: ChangelogStatusContext): boolean;
/** Recognize an affirmative delivery with a PR/commit reference, never a bare issue link. */
export declare function recordsDelivery(value: unknown): boolean;
/** Tracker evidence sufficient to label an issue as a repair; no git access occurs. */
export declare function hasRepairEvidence(item: PmItem): boolean;
/** A factual closure without recorded repair evidence must use neutral wording. */
export declare function needsNeutralClosure(item: PmItem, context?: ChangelogStatusContext): boolean;
/** Count explicit non-change closures across input before status/release narrowing. */
export declare function countNonChangeClosures(items: readonly PmItem[], context?: ChangelogStatusContext): number;
//# sourceMappingURL=closure-policy.d.ts.map