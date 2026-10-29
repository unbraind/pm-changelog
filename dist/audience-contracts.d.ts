import type { AgentObligation } from "./agent-contract-drift.ts";
import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { GenerateChangelogOptions } from "./types.ts";
import type { UpgradeAction } from "./upgrade-actions.ts";
/** Explicit publishing targets, in canonical output order. */
export declare const CHANGE_AUDIENCES: readonly ["api-user", "operator", "agent-behavior"];
/** One supported consumer of a versioned change contract. */
export type ChangeAudience = typeof CHANGE_AUDIENCES[number];
/** Exact author-declared prose, or an explicit opt-in to existing resolution prose. */
export type ChangeFacet = {
    audience: ChangeAudience;
    breaking?: true;
    upgrade_actions?: UpgradeAction[];
    obligations?: AgentObligation[];
} & ({
    text: string;
    source?: never;
} | {
    source: "close_reason";
    text?: never;
});
/** Selection delegates to the existing generator; only closed change items are published. */
export interface AudienceContractOptions extends Pick<GenerateChangelogOptions, "items" | "version" | "groupBy" | "sectionBy" | "since" | "until" | "excludeTags" | "releaseWindows" | "releaseMembership" | "suppressedPendingRelease" | "limit" | "sinceVersion" | "respectItemRelease" | "statusRegistry" | "statusSelection" | "omittedNonChangeIds"> {
    audience?: ChangeAudience;
}
/** Shared, prose-free identity of one selected change in one release section. */
export interface ChangeAttribution {
    item: string;
    release: string;
    section: string;
}
/** Audience-visible notes and explicit omissions reference the shared ledger by zero-based index. */
export interface AudienceChangeContract {
    audience: ChangeAudience;
    notes: {
        attribution: number;
        text: string;
    }[];
    omissions: {
        attribution: number;
        reason: "missing_facet" | "missing_resolution";
    }[];
}
/** Deterministic contract bundle; no clock, tracker bodies or other audience prose in its ledger. */
export interface AudienceContractReport {
    schema_version: 1;
    ledger_sha256: string;
    item_count: number;
    note_count: number;
    omission_count: number;
    ledger: ChangeAttribution[];
    contracts: AudienceChangeContract[];
}
/** Stable refusal codes and remedies are available through both SDK and CLI. */
export declare class AudienceContractError extends PmCliError {
    readonly code: "invalid_audience" | "invalid_facets" | "ambiguous_items" | "invalid_contract_options";
    readonly remedy: string;
    /** Retain expected-error semantics so the host exits nonzero instead of swallowing refusals. */
    constructor(code: AudienceContractError["code"], remedy: string);
}
/** Validate audience input without interpreting unknown spellings as all audiences. */
export declare function parseChangeAudience(value: unknown): ChangeAudience;
/** Publish declared facets using the generator's release, section, closure and resolution policies.
 * Canonical identity is independent of the audience filter. Missing source prose never falls back
 * to an item's title. Source items are neither mutated nor treated as proof of actual deployment.
 */
export declare function buildAudienceContracts(options: AudienceContractOptions): AudienceContractReport;
/** Read complete core metadata through the backend-aware SDK; this path never invokes git. */
export declare function readAudienceContracts(pmRoot: string, options?: Omit<AudienceContractOptions, "items">): Promise<AudienceContractReport>;
/** Compact JSON or TOON tables, storing the shared attribution ledger exactly once. */
export declare function formatAudienceContracts(report: AudienceContractReport, format: "json" | "toon"): string;
//# sourceMappingURL=audience-contracts.d.ts.map