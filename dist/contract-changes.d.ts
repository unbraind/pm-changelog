import type { PmItem } from "./types.ts";
/** Explicit observable SDK or CLI behavior change, with caller migration guidance. */
export interface ContractChange {
    api?: string;
    before: string;
    after: string;
    migrate: string;
}
/** Read the item's authored contract declaration: the one presentation policy
 * shared by Markdown, JSON, summary and audit. Every declaration of a rendered
 * item publishes; closure evidence still governs repair and semver classification.
 * Diagnostics describe only assertions the changelog claims. */
export declare function readContractChange(item: PmItem): ContractChange | undefined;
//# sourceMappingURL=contract-changes.d.ts.map