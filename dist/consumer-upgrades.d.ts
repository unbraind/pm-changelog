import type { PlanResultPlan } from "@unbrained/pm-cli/sdk";
import type { ChangeAudience } from "./audience-contracts.ts";
import type { ChangelogStatusContext, PmItem } from "./types.ts";
import type { UpgradeAction } from "./upgrade-actions.ts";
export { ConsumerUpgradeError, parseUpgradeActions } from "./upgrade-actions.ts";
export type { ConsumerUpgradeErrorCode, UpgradeAction } from "./upgrade-actions.ts";
/** Reuse the public core Plan contract without owning a second step lifecycle. */
type CorePlanStep = NonNullable<PlanResultPlan["steps"]>[number];
/** One pending core Plan step plus its release provenance and prerequisite IDs. */
export interface ConsumerUpgradeStep extends UpgradeAction, Pick<CorePlanStep, "order" | "status"> {
    attribution: {
        item: string;
        release: string;
    }[];
}
/** Installed version is exclusive; target version is inclusive. Both are explicit. */
export interface ConsumerUpgradeOptions extends ChangelogStatusContext {
    items: PmItem[];
    audience: ChangeAudience;
    from: string;
    to: string;
}
/** Read-only projection: no execution receipts, timestamps, target revisions or persisted state. */
export interface ConsumerUpgradeReport {
    schema_version: 1;
    audience: ChangeAudience;
    from: string;
    to: string;
    action_count: number;
    satisfied_prerequisites: string[];
    omissions: {
        item: string;
        release: string;
        reason: "missing_actions";
    }[];
    steps: ConsumerUpgradeStep[];
}
/** Compile release obligations using core's ordering ontology and existing facet selection.
 * Repeated IDs must have identical definitions; earliest publication determines applicability.
 * Prerequisites published at/before the installed version are already satisfied. Other
 * prerequisites must be selected for this audience and interval. No source item is mutated.
 */
export declare function buildConsumerUpgrades(options: ConsumerUpgradeOptions): ConsumerUpgradeReport;
/** Read certified complete native metadata through the backend-aware SDK; never invoke git. */
export declare function readConsumerUpgrades(pmRoot: string, options: Omit<ConsumerUpgradeOptions, "items">): Promise<ConsumerUpgradeReport>;
/** Emit compact agent output without duplicating source prose or tracker state. */
export declare function formatConsumerUpgrades(report: ConsumerUpgradeReport, format: "json" | "toon"): string;
//# sourceMappingURL=consumer-upgrades.d.ts.map