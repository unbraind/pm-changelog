import type { GenerateChangelogOptions } from "./types.ts";
/** A caller-supplied test execution receipt; declarations alone never prove success. */
export interface ClaimTestReceipt {
    item: string;
    command: string;
    outcome: "passed" | "failed";
    reference: string;
}
/** Stable diagnostics and recovery guidance for each absent evidence dimension. */
export declare const CLAIM_AUDIT_REMEDIES: {
    readonly resolution: "Record the delivered outcome in close_reason or resolution.";
    readonly tests: "Link a test command or test path to the item.";
    readonly test_result: "Supply a passing receipt matching a linked command or path; retain its evidence reference.";
    readonly delivery: "Record an affirmative merged/delivered PR or commit reference.";
    readonly repair: "Record repair evidence or regenerate the claim with neutral Closed wording.";
    readonly dependency: "Audit dependency delivery with pm-ops; commit subjects alone do not prove publication.";
};
/** One explicitly missing piece of claim support. */
export type ClaimAuditGap = keyof typeof CLAIM_AUDIT_REMEDIES;
/** Recorded sources, kept once per item rather than duplicated for repeated claims. */
export interface ClaimAuditEvidence {
    item: string;
    resolution: string[];
    files: string[];
    tests: string[];
    test_receipts: ClaimTestReceipt[];
    delivery: string[];
}
/** A one-based line in the exact generated markdown, with its source and gaps. */
export interface ClaimAuditRow {
    line: number;
    release: string;
    section: string;
    claim: string;
    items: string[];
    gaps: ClaimAuditGap[];
}
/** Deterministic release audit; no timestamps, source mutation or network validation. */
export interface ClaimAuditReport {
    schema_version: 1;
    markdown_sha256: string;
    claim_count: number;
    unsupported_count: number;
    ready: boolean;
    claims: ClaimAuditRow[];
    evidence: ClaimAuditEvidence[];
    remedies: Partial<typeof CLAIM_AUDIT_REMEDIES>;
}
/** Typed fail-closed audit errors with a concrete recovery step. */
export declare class ClaimAuditError extends Error {
    readonly exitCode = 1;
    readonly code: "ambiguous_items" | "invalid_receipts" | "unsupported_claims" | "git_required";
    readonly remedy: string;
    readonly report?: ClaimAuditReport;
    /** Preserve the refusal code and optional complete gap report for automation. */
    constructor(code: ClaimAuditError["code"], remedy: string, report?: ClaimAuditReport);
}
/** Validate receipts before accepting a caller's execution assertions. */
export declare function parseClaimTestReceipts(value: unknown): ClaimTestReceipt[];
/** Map rendered claims without writes; tracker-only options never invoke git.
 * Receipts are caller assertions, not independently verified CI or publication proof.
 * A failed receipt for a command dominates passing receipts for that same command.
 */
export declare function auditChangelogClaims(options: GenerateChangelogOptions, testReceipts?: readonly ClaimTestReceipt[]): ClaimAuditReport;
/** Refuse publication while retaining all unsupported claims and their remedies. */
export declare function assertChangelogClaims(report: ClaimAuditReport): void;
/** Compact JSON or TOON with one table row per claim and no repeated tracker bodies. */
export declare function formatClaimAudit(report: ClaimAuditReport, format: "json" | "toon"): string;
//# sourceMappingURL=claim-audit.d.ts.map