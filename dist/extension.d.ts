import { locateItem, readLocatedItem, readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";
import type { ChangelogItemRefStyle, PmItem } from "./types.ts";
/**
 * Marks a command result as JSON text that pm-changelog has already rendered.
 *
 * Scoped host ownership ensures only changelog commands can route this marker
 * to the extension's toon and JSON renderer callbacks.
 */
interface RenderedCommandResult {
    pmChangelogRendered: true;
    output: string;
}
/** SDK operations used to enrich body previews, injectable at the filesystem boundary. */
interface BodyEnrichmentDependencies {
    readSettings: typeof readSettings;
    resolveItemTypeRegistry: typeof resolveItemTypeRegistry;
    locateItem: typeof locateItem;
    readLocatedItem: typeof readLocatedItem;
}
/** Determine whether an unknown command result carries valid pre-rendered changelog output. */
declare function isRenderedCommandResult(value: unknown): value is RenderedCommandResult;
/** Serialize a structured changelog value into the marker consumed by scoped renderers. */
declare function renderedCommandResult(value: unknown): RenderedCommandResult;
/** Return owned pre-rendered output or defer unrelated results to the host renderer. */
declare function renderCommandResult(context: {
    result?: unknown;
} | undefined): string | null;
declare const _default: {
    name: string;
    version: string;
    activate(api: import("@unbrained/pm-cli/sdk").ExtensionApi): void;
};
export default _default;
/**
 * Best-effort enrichment of item metadata with the on-disk body, used so
 * `--body-preview` renders real body content in the extension path (GH #27).
 * `listAllItemMetadata` omits bodies, so each item is re-read via the public SDK
 * locate/read helpers. Items already carrying a body are skipped, and any
 * per-item read failure is swallowed so changelog generation never breaks.
 */
declare function enrichItemBodies(pmRoot: string, items: PmItem[], dependencies?: BodyEnrichmentDependencies): Promise<void>;
/**
 * Missing git tag history is an environment prerequisite failure, not a usage
 * error: rethrow the structured diagnostic as a PmCliError with a non-zero
 * exit so release gates stop instead of misreporting a correct CHANGELOG.md as
 * stale (the CLI path surfaces the same message via its main() error handler).
 */
declare function withTagHistoryDiagnostics<T>(resolve: () => T): T;
/** Render release-context option failures as real CLI usage errors.
 * The SDK host converts ordinary thrown errors into warnings, which would let
 * an invalid fallback invocation appear successful to automation. */
declare function withReleaseContextDiagnostics<T>(resolve: () => T): T;
declare function stringOption(options: Record<string, unknown>, kebabKey: string, camelKey: string): string | undefined;
declare function booleanOption(options: Record<string, unknown>, kebabKey: string, camelKey: string): boolean;
/** OPT-IN (`--item-ref-style`): how each entry cites its pm item. Rejects any
 * spelling outside the four supported styles rather than silently falling back,
 * so a typo surfaces as a usage error instead of a differently-rendered
 * changelog. Absent → `undefined`, leaving the generator's own default. */
declare function itemRefStyleOption(options: Record<string, unknown>): ChangelogItemRefStyle | undefined;
/** OPT-IN (`--exclude-tag`): comma-separated tag list, or an array when the host
 * passes a repeated flag. Absent/blank → `undefined`, which leaves generation
 * unfiltered. */
declare function excludeTagsOption(options: Record<string, unknown>): string[] | undefined;
/** OPT-IN (`--limit`): how many of the most recent release sections to keep,
 * applying only where release windows produced the sections - it is not a cap
 * on items. Accepts the host's number or its string spelling, and rejects zero,
 * negatives, and fractions as usage errors so an unusable value never silently
 * truncates a changelog. Absent/blank → `undefined`, meaning every release. */
declare function parseLimitOption(options: Record<string, unknown>): number | undefined;
/** OPT-IN (`--body-preview`): how many characters of an item's body to inline
 * beneath its entry. Validated exactly like `--limit`, so a malformed width is
 * a usage error rather than a truncated-to-nothing preview. Absent/blank →
 * `undefined`, which omits body previews entirely. */
declare function parseBodyPreviewOption(options: Record<string, unknown>): number | undefined;
/** Internal behavior surface used by package-local extension coverage tests. */
export declare const extensionTestSurface: {
    bodyEnrichmentDependencies: BodyEnrichmentDependencies;
    booleanOption: typeof booleanOption;
    enrichItemBodies: typeof enrichItemBodies;
    excludeTagsOption: typeof excludeTagsOption;
    isRenderedCommandResult: typeof isRenderedCommandResult;
    itemRefStyleOption: typeof itemRefStyleOption;
    parseBodyPreviewOption: typeof parseBodyPreviewOption;
    parseLimitOption: typeof parseLimitOption;
    renderCommandResult: typeof renderCommandResult;
    renderedCommandResult: typeof renderedCommandResult;
    stringOption: typeof stringOption;
    withReleaseContextDiagnostics: typeof withReleaseContextDiagnostics;
    withTagHistoryDiagnostics: typeof withTagHistoryDiagnostics;
};
//# sourceMappingURL=extension.d.ts.map