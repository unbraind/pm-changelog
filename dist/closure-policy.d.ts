import type { PmItem } from "./types.ts";
/** Explicit non-change dispositions override links and old repair evidence. */
export declare function isNonChangeClosure(item: PmItem): boolean;
/** Recognize an affirmative delivery with a PR/commit reference, never a bare issue link. */
export declare function recordsDelivery(value: unknown): boolean;
/** Tracker evidence sufficient to label an issue as a repair; no git access occurs. */
export declare function hasRepairEvidence(item: PmItem): boolean;
/** A factual closure without recorded repair evidence must use neutral wording. */
export declare function needsNeutralClosure(item: PmItem): boolean;
/** Count explicit non-change closures across input before status/release narrowing. */
export declare function countNonChangeClosures(items: readonly PmItem[]): number;
//# sourceMappingURL=closure-policy.d.ts.map