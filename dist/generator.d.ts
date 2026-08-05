import type { ChangelogDocument, ChangelogSelectionReport, ChangelogSummaryEntry, GeneratedChangelog, GenerateChangelogOptions, MergeChangelogOptions, MergeChangelogResult, PmItem, ReadPmItemsOptions, SemverSuggestion, WriteChangelogOptions, WriteChangelogResult } from "./types.ts";
/** Render a changelog and return only its markdown. Convenience wrapper over
 * {@link createChangelog} for callers that do not need the selected sections. */
export declare function generateChangelog(options: GenerateChangelogOptions): string;
/** Render a changelog, returning the markdown alongside the sections and item
 * count it was built from so a caller can report on the selection without
 * re-parsing its own output. */
export declare function createChangelog(options: GenerateChangelogOptions): GeneratedChangelog;
/**
 * OPT-IN (`--changelog-json`): build a structured representation of the
 * changelog (releases -> sections -> items) for downstream tooling. This is
 * deliberately distinct from the `--json` CLI summary (action/bytes/changed)
 * and from the `changelog export --format json` payload (which wraps markdown).
 * It applies the same filtering, limiting and grouping as the markdown path so
 * the two stay in sync, but emits structured data instead of rendered text.
 */
export declare function buildChangelogDocument(options: GenerateChangelogOptions): ChangelogDocument;
/**
 * OPT-IN (`--summary`): build a compact one-line-per-change list for quick
 * agent scanning. Reuses the same filtering, section building, visibility
 * narrowing and grouping as the markdown / structured-document paths so the
 * three stay in sync, but emits flat entries instead of rendered text.
 *
 * Each entry carries the release heading, the category or field-group the item
 * was bucketed under, and the item's id/title/type/status. With the default
 * `sectionBy: "category"` the `category` field is the keep-a-changelog category
 * (Added/Changed/Fixed/...); with `sectionBy: "type"` it is the title-cased item
 * type (Feature/Issue/Task/...); with `sectionBy: "label"` an item may appear
 * once per tag.
 */
export declare function createChangelogSummary(options: GenerateChangelogOptions): ChangelogSummaryEntry[];
/**
 * Format one summary entry as stable bracketed text for agent scanning:
 * `[version] category: title (id)`.
 */
export declare function formatSummaryLine(entry: ChangelogSummaryEntry): string;
/**
 * Splice a freshly generated release section into an existing changelog.
 *
 * A release already present is replaced in place rather than duplicated, and a
 * new one is inserted directly beneath the title so history stays newest-first.
 * The reported action distinguishes an unchanged file from a rewritten one,
 * which is what lets `--check` fail only on real drift.
 */
export declare function mergeChangelog(existingMarkdown: string | undefined, generatedMarkdown: string, options?: MergeChangelogOptions): MergeChangelogResult;
/** Build the `pm list-all --json` argv used to read a workspace. `--pm-path`
 * is unshifted ahead of the subcommand because it is a host-owned global flag
 * and pm rejects it in trailing position. */
export declare function buildPmListArgs(options?: ReadPmItemsOptions): string[];
/**
 * Read every item from a pm workspace by invoking the real pm CLI.
 *
 * Shelling out rather than parsing `.toon` files directly keeps the workspace's
 * own schema, merge, and visibility rules authoritative, so this package never
 * has to track pm's storage format. With no explicit binary the installed
 * `@unbrained/pm-cli` is resolved through its manifest and run on the current
 * Node executable, which keeps the lookup working on Windows and inside
 * pnpm-style layouts where the `.bin` shim may not be reachable. The buffer cap
 * is explicit because Node's 1 MiB default truncates a large workspace's JSON
 * into a parse error that reads like corruption.
 */
export declare function readPmItems(options?: ReadPmItemsOptions): PmItem[];
/** Generate and persist a changelog, or with `check` compare against what is on
 * disk without writing. The returned `changed` flag is the drift signal CI acts
 * on; check mode never touches the file, so a failing gate leaves the committed
 * changelog intact. */
export declare function writeChangelog(options: WriteChangelogOptions): WriteChangelogResult;
/** Parse pm JSON, accepting either a bare array or the `{ items: [...] }`
 * envelope, since which one pm emits depends on the command and version. */
export declare function parsePmItemsJson(raw: string): PmItem[];
/** Order two release headings, pinning a `fallback` heading (the unset
 * `Unreleased` bucket) ahead of every versioned release, then newest-first by
 * version. Exported for direct testing because the comparator's fallback and
 * segment-count edges are most reliably exercised up close.
 *
 * @param a - First release heading text.
 * @param b - Second release heading text.
 * @param fallback - Heading that always sorts first.
 * @returns Negative, zero, or positive per `Array.sort` convention.
 */
export declare function compareVersionHeadings(a: string, b: string, fallback: string): number;
/** Order two version strings segment by segment, comparing numerically where
 * both segments are numbers so `1.10.0` sorts above `1.9.0`, and lexically
 * otherwise so prerelease suffixes still order deterministically. */
export declare function compareVersionStrings(a: string, b: string): number;
/**
 * Summarize how the visible items' release-window placement was timestamped:
 * authoritative (`completed_at`, `fallback: false`) versus an inferred fallback
 * (`closed_at`/`updated_at`/`created_at`, `fallback: true`). The inferred
 * sample names the items a maintainer should inspect for a shipped-but-late-
 * closed tracker that dated into the wrong release. Returns `undefined` when no
 * items survived to a visible section so the field stays absent, not empty.
 *
 * Items whose placement came from their own declared `release` are counted
 * under `release_pinned` instead of being offered as late-close candidates,
 * since no timestamp decided where they landed. See
 * {@link isPlacedByReleaseDeclaration} - both the multi-window and
 * single-version placement paths honour a declaration.
 *
 * The sample is ordered by resolved timestamp, most recent first, matching the
 * documented contract: a maintainer hunting a mis-dated tracker wants the
 * freshest candidate, not whichever section happened to be emitted first.
 */
/**
 * Render the inferred-source counts as a stable, comma-separated field list for
 * human-facing output. Sorted so the string is deterministic across runs, and
 * `"fallback"` stands in for the empty map so a caller never prints an empty
 * parenthesis. Shared by the generator's hint text and the CLI's selection
 * report so the two can never drift apart.
 */
export declare function formatInferredSources(sources: Record<string, number>): string;
/**
 * OPT-IN (`--suggest-semver`): classify the in-scope items into breaking /
 * feature / fix / other and recommend a semver bump. Emitted as JSON or a
 * footer note; never alters default markdown.
 */
export declare function suggestSemver(options: GenerateChangelogOptions): SemverSuggestion;
/**
 * The items that actually render for the given options: the union of all
 * visible release-section items after filtering, empty-section pruning and
 * `--limit`/`--since-version` narrowing. Exposed so semver suggestions and the
 * structured `--changelog-json` document classify the same set the markdown
 * emits (GH #28).
 */
export declare function visibleChangelogItems(options: GenerateChangelogOptions): PmItem[];
/**
 * OPT-IN (`--explain`): return machine-readable diagnostics showing how input
 * items moved through title/status/time/release-window filters and visibility
 * narrowing (`--limit`/`--since-version`). Designed for agent/operator UX when
 * output is unexpectedly empty or smaller than expected.
 */
export declare function explainChangelogSelection(options: GenerateChangelogOptions): ChangelogSelectionReport;
/** Classify an explicit item set into a semver bump (no option-driven filtering). */
export declare function suggestSemverForItems(items: PmItem[]): SemverSuggestion;
//# sourceMappingURL=generator.d.ts.map