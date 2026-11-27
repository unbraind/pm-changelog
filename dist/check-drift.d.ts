/** Failure categories describe observable output, never a successful check. */
export type CheckDriftClassification = "reorder_only" | "rendering_changed" | "tracker_changed";
/** An advisory for file checks whose versioned Markdown still matches. */
export declare const PENDING_ONLY_MESSAGE = "Drift classification: pending_only. Only Unreleased differs.";
/** Retained Markdown bytes and the link definitions that affect those bytes. */
export interface PendingDriftProjection {
    markdown: string;
    linkedDefinitions: () => string | undefined;
}
/** Compare retained bytes first, then the effective document-scoped definitions.
 * A missing file must still be created, even for an empty release history. */
export declare function isPendingOnlyDrift(committed: string | undefined, generated: string, withoutPending: (markdown: string) => PendingDriftProjection): boolean;
/** Compare the first definition of each retained link or image reference.
 * Parse the whole input so definitions in pending, nested, or later blocks can
 * still resolve retained text. Walk in source order so the pending cursor only
 * advances. Definition layout and shadowed definitions have no link effect. */
export declare function retainedReferenceDefinitions(markdown: string, pending: readonly (readonly [number, number])[]): string | undefined;
/** Rendering revisions belonging to the two renderings being compared. */
export interface RenderingRevisions {
    current: string;
    previous: string;
}
/** Compare entry units without losing section boundaries or continuation prose. */
export declare function isEntryReorder(committed: string, generated: string): boolean;
/** An upgrade needs different revisions AND an exact previous-renderer match.
 * A current-version/manual/timestamp reorder supplies neither proof on its own. */
export declare function classifyCheckDrift(committed: string, generated: string, previous: () => string, revisions: RenderingRevisions): CheckDriftClassification;
/** One retained comparison profile with the upgrade that changed its output. */
export interface HistoricalRenderingComparison {
    version: string;
    changedIn: string;
    render: () => string;
}
/** Exact historical matches retain their upgrade evidence beyond the last release. */
export declare function diagnoseCheckDrift(committed: string, generated: string, current: string, comparisons: readonly HistoricalRenderingComparison[]): {
    classification: CheckDriftClassification;
    changedIn?: string;
    comparedVersion?: string;
};
/** Canonical parsed flags only; arrays retain repeated option/value pairs. */
export type RegenerationOptions = Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>;
/** A ready command or an explicit requirement to restore the original input. */
export interface RegenerationGuidance {
    argv: string[];
    command?: string;
    input_required: boolean;
    shell: "posix" | "powershell";
    message: string;
}
/** Resolve host camel/kebab spellings through the command's actual flag registry.
 * Unknown host internals are not command flags. Canonical supplied keys win. */
export declare function canonicalRegenerationOptions(options: Readonly<Record<string, unknown>>, flags: readonly {
    long?: string;
}[]): RegenerationOptions;
/** Build from parsed flags, never process.argv or an inferred host entrypoint.
 * Equals syntax keeps leading-dash option values intact, notably --pm-arg pairs.
 * Receipts always include argv, and Windows text explicitly targets PowerShell. */
export declare function regenerationCommand(options: RegenerationOptions, invocation: readonly string[], platform?: NodeJS.Platform): RegenerationGuidance;
/** A tracker reorder is distinct from a proved upgrade, even with equal lines. */
export declare function trackerReorderExplanation(committed: string, generated: string): string;
//# sourceMappingURL=check-drift.d.ts.map