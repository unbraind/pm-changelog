import type { PmItem } from "./types.ts";
/** Explicit observable SDK or CLI behavior change, with caller migration guidance. */
export interface ContractChange {
    api?: string;
    before: string;
    after: string;
    migrate: string;
}
/** Preserve incomplete historical declarations as auditable gaps, never inferred prose. */
export declare function readContractChange(item: PmItem): ContractChange | undefined;
//# sourceMappingURL=contract-changes.d.ts.map