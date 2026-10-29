import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { ChangelogStatusContext, PmItem } from "./types.ts";
/** Stable, explicit identity and behavior; evidence is provenance rather than an assumption. */
export type AgentObligation = {
    id: string;
    evidence: string[];
} & ({
    assumption: string;
    commands: string[];
    removed?: never;
} | {
    removed: true;
    assumption?: never;
    commands?: never;
});
/** Expected refusals carry a stable discriminator and public-safe recovery instructions. */
export declare class AgentContractDriftError extends PmCliError {
    /** Stable machine discriminator, independent of rendered wording. */
    readonly code: "invalid_drift_options" | "invalid_obligation" | "ambiguous_contract" | "invalid_drift_report";
    /** Actionable recovery without source prose or operator paths. */
    readonly remedy: string;
    /** Preserve nonzero expected-error semantics in the host and standalone CLI. */
    constructor(code: AgentContractDriftError["code"], remedy: string);
}
/** The single strict declaration schema, shared by consumers and authoring producers.
 * Identity is package-wide and case-sensitive. No normalization is inferred from prose.
 */
export declare function parseAgentObligation(value: unknown): AgentObligation;
/** Numeric stable releases only, with exact safe-integer components and daily suffixes. */
export declare function parseAgentContractRange(from: unknown, to: unknown): {
    from: string;
    to: string;
};
/** A definition appears once; rows below refer to its zero-based index. */
export interface AgentContractDefinition {
    id: string;
    assumption: string;
    commands: string[];
}
/** Provenance belongs to each observation even when its assumption is unchanged. */
export interface AgentContractReference {
    release: string;
    ref: number;
    items: string[];
    evidence: string[];
}
/** Explicit state transitions retain both sides; removed commands remain reachable via before. */
export interface AgentContractChange {
    release: string;
    id: string;
    kind: "added" | "removed" | "changed";
    before: number | null;
    after: number | null;
    items: string[];
    evidence: string[];
}
/** Per-record omissions never suppress a valid sibling declaration. */
export interface AgentContractOmission {
    item: string;
    facet: number | null;
    obligation: number | null;
    reason: "invalid_facets" | "missing_obligations" | "invalid_obligation" | "unversioned" | "orphan_removal";
}
/** Read-only comparison over (from,to], seeded with declarations at or before from. */
export interface AgentContractDriftOptions extends ChangelogStatusContext {
    items: PmItem[];
    from: string;
    to: string;
}
/** Compact declared coverage, never an assertion that undeclared behavior stayed unchanged. */
export interface AgentContractDriftReport {
    schema_version: 1;
    from: string;
    to: string;
    complete: boolean;
    definitions: AgentContractDefinition[];
    baseline: AgentContractReference[];
    changes: AgentContractChange[];
    unchanged: AgentContractReference[];
    omissions: AgentContractOmission[];
}
/** Build a deterministic delta index using the package's shared release and closure selection.
 * Absence is not removal. Same-release conflicting definitions refuse rather than invent an order.
 * Malformed records are omissions; valid sibling obligations still contribute.
 */
export declare function buildAgentContractDrift(options: AgentContractDriftOptions): AgentContractDriftReport;
/** Certified metadata and configured status roles use the supported SDK import, with no git path. */
export declare function readAgentContractDrift(pmRoot: string, options: Omit<AgentContractDriftOptions, "items" | "statusRegistry">): Promise<AgentContractDriftReport>;
/** Validate emitted references and definitions with the declaration producer's strict schema. */
export declare function formatAgentContractDrift(report: AgentContractDriftReport, format: "json" | "toon"): string;
//# sourceMappingURL=agent-contract-drift.d.ts.map