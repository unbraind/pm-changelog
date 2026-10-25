import { PmCliError } from "@unbrained/pm-cli/sdk";
import type { PlanResultPlan } from "@unbrained/pm-cli/sdk";
/** Explicit inert instructions reuse the public core Plan prose contract. */
export interface UpgradeAction extends Pick<NonNullable<PlanResultPlan["steps"]>[number], "id" | "title" | "body"> {
    requires: string[];
}
/** Stable refusal discriminator shared by the SDK and both command transports. */
export type ConsumerUpgradeErrorCode = "invalid_upgrade_options" | "invalid_upgrade_actions" | "ambiguous_upgrade_action" | "missing_prerequisite" | "upgrade_cycle";
/** Expected usage failure with an actionable, public-safe remedy. */
export declare class ConsumerUpgradeError extends PmCliError {
    /** Stable machine-readable refusal independent of rendered text. */
    readonly code: ConsumerUpgradeErrorCode;
    /** Corrective action that can be shown without leaking tracker contents. */
    readonly remedy: string;
    /** Preserve the host's nonzero expected-error behavior. */
    constructor(code: ConsumerUpgradeErrorCode, remedy: string);
}
/** Validate declarations without normalizing authored title/body whitespace. */
export declare function parseUpgradeActions(value: unknown, breaking: unknown): UpgradeAction[];
//# sourceMappingURL=upgrade-actions.d.ts.map