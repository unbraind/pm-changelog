/** Canonical stable numeric release identity; unknown legacy headings remain unclassified. */
export declare function parseContractRelease(value: unknown): string | undefined;
/** Read numeric identity using the generator's heading grammar, independently of strict range inputs. */
export declare function parseContractReleaseHeading(value: unknown): string | undefined;
/** Exclude known future releases before interpreting facets; unknown headings keep legacy handling. */
export declare function isContractReleaseAfter(value: unknown, upper: string): boolean;
//# sourceMappingURL=contract-versions.d.ts.map