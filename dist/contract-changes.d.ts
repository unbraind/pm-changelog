import type { ChangelogStatusContext, PmItem } from "./types.ts";
/** Explicit observable SDK or CLI behavior change, with caller migration guidance. */
export interface ContractChange {
    api?: string;
    before: string;
    after: string;
    migrate: string;
}
/** Preserve incomplete historical declarations as auditable gaps, never inferred prose. */
export declare function readContractChange(item: PmItem): ContractChange | undefined;
/** Share the renderer's declaration eligibility with every consumer of published claims. */
export declare function readPresentedContractChange(item: PmItem, context: ChangelogStatusContext): ContractChange | undefined;
//# sourceMappingURL=contract-changes.d.ts.map