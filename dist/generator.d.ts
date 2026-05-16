import type { GeneratedChangelog, GenerateChangelogOptions, MergeChangelogOptions, MergeChangelogResult, PmItem, ReadPmItemsOptions } from "./types.js";
export declare function generateChangelog(options: GenerateChangelogOptions): string;
export declare function createChangelog(options: GenerateChangelogOptions): GeneratedChangelog;
export declare function mergeChangelog(existingMarkdown: string | undefined, generatedMarkdown: string, options?: MergeChangelogOptions): MergeChangelogResult;
export declare function readPmItems(options?: ReadPmItemsOptions): PmItem[];
export declare function parsePmItemsJson(raw: string): PmItem[];
//# sourceMappingURL=generator.d.ts.map