#!/usr/bin/env node
import type { Readable } from "node:stream";
import type { ChangelogGroupBy, ChangelogItemRefStyle, ChangelogReleaseWindow, ChangelogSelectionReport, ChangelogSectionBy, PmItem } from "./types.ts";
interface CliOptions {
    output: string;
    stdout: boolean;
    json: boolean;
    input?: string;
    stdin: boolean;
    pmRoot?: string;
    pmBin?: string;
    pmArgs: string[];
    pmCwd?: string;
    title?: string;
    version?: string;
    versionFromPackage: boolean;
    date?: string;
    since?: string;
    sincePreviousTag: boolean;
    until?: string;
    untilReleaseTag: boolean;
    allReleaseTags: boolean;
    releaseTagPattern: string;
    statuses?: string[];
    groupBy: ChangelogGroupBy;
    sectionBy: ChangelogSectionBy;
    summary: boolean;
    format: "md" | "json";
    conventional: boolean;
    contributors: boolean;
    limit?: number;
    sinceVersion?: string;
    breakingChanges: boolean;
    suggestSemver: boolean;
    bodyPreview?: number;
    emojiPrefix: boolean;
    includeMetadata: boolean;
    changelogJson: boolean;
    releaseWindows?: ChangelogReleaseWindow[];
    includeEmpty: boolean;
    includeLinks: boolean;
    itemUrlBase?: string;
    itemRefStyle?: ChangelogItemRefStyle;
    respectItemRelease: boolean;
    excludeTags: string[];
    mode: "replace" | "prepend";
    check: boolean;
    checkDiff: boolean;
    explain: boolean;
    githubOutput: boolean;
    githubStepSummary: boolean;
}
/** Run one CLI invocation end to end: parse flags, resolve the release context
 * from git, load items, generate, then write or compare. */
declare function main(args?: string[]): Promise<void>;
/** Turn argv into validated options, rejecting an unknown flag with a
 * near-miss suggestion rather than ignoring it - a silently dropped flag would
 * generate a subtly different changelog and still exit zero. */
declare function parseArgs(args: string[]): CliOptions;
/** Split `--flag=value` into separate tokens so both spellings reach one
 * parsing path. */
declare function normalizeArgs(args: string[]): string[];
declare function resolveOptionAlias(arg: string): string;
/** Build the rejection for an unrecognized flag, with a spelling suggestion when
 * one is close enough to be worth offering. The raw `arg` is echoed rather than
 * the normalized token so the message quotes what the caller actually typed,
 * including any `=value` suffix — a user who wrote `--modes=prepend` needs to see
 * that spelling to spot the error. */
declare function unknownOptionError(arg: string): Error;
declare function optionToken(arg: string): string;
/** Find the closest known flag to a mistyped one, or `undefined` when nothing
 * is close enough to be worth suggesting. Ties break toward the shorter name so
 * the suggestion is the more common flag. */
declare function suggestOption(arg: string, knownOptions?: readonly string[]): string | undefined;
/** Levenshtein distance between two strings, used only to rank flag
 * suggestions. */
declare function editDistance(left: string, right: string): number;
/** Fill version, date, and time bounds from the checkout, mutating `options` in
 * place. The version may come from the nearest package.json; the dates and
 * bounds come from git tags. Explicit flags are preserved; only gaps filled. */
declare function applyReleaseContext(options: CliOptions): void;
/** Load pm items from stdin, a JSON file, or the real pm CLI, in that order of
 * precedence. Bodies are requested only when a preview will render them, since
 * they make the list payload substantially larger. */
declare function loadItems(options: CliOptions, input?: Readable): Promise<PmItem[]>;
/** Read stdin to completion as UTF-8, for `--stdin` item input. */
declare function readStdin(input?: Readable): Promise<string>;
declare function parseGroupBy(value: string): ChangelogGroupBy;
declare function parseSectionBy(value: string): ChangelogSectionBy;
/** Validate `--item-ref-style`, rejecting unknown spellings so a typo cannot
 * quietly change how every entry cites its item. */
declare function parseItemRefStyle(value: string): ChangelogItemRefStyle;
/** Validate `--limit` as a positive integer count of release sections. */
declare function parseLimit(value: string): number;
/** Validate `--body-preview` as a positive character width. */
declare function parseBodyPreview(value: string): number;
declare function parseMode(value: string): "replace" | "prepend";
/** Resolve the `--format` argument to the two shapes the generator emits.
 * Accepts `markdown` as an alias for `md` because the flag reads as prose and
 * the long spelling is the natural guess; case and surrounding whitespace are
 * normalized so a value copied from a shell script still matches. Anything else
 * throws rather than defaulting, so a typo cannot silently produce the wrong
 * output format in a release job. */
declare function parseFormat(value: string): "md" | "json";
/** Project parsed CLI options plus the loaded items onto the generator's option
 * shape. An empty `--exclude-tag` list is passed as `undefined` so the filter
 * stays entirely inert rather than running against nothing. */
declare function buildGenerationOptions(options: CliOptions, items: PmItem[]): {
    items: PmItem[];
    title: string | undefined;
    version: string | undefined;
    date: string | undefined;
    since: string | undefined;
    until: string | undefined;
    releaseWindows: ChangelogReleaseWindow[] | undefined;
    includeStatuses: string[] | undefined;
    groupBy: ChangelogGroupBy;
    sectionBy: ChangelogSectionBy;
    conventional: boolean;
    contributors: boolean;
    limit: number | undefined;
    sinceVersion: string | undefined;
    breakingChanges: boolean;
    bodyPreview: number | undefined;
    emojiPrefix: boolean;
    includeMetadata: boolean;
    suggestSemver: boolean;
    includeEmpty: boolean;
    includeLinks: boolean;
    itemUrlBase: string | undefined;
    itemRefStyle: ChangelogItemRefStyle | undefined;
    respectItemRelease: boolean;
    excludeTags: string[] | undefined;
};
/** Assemble the machine-readable run summary emitted by `--json` and written as
 * GitHub step outputs. The job-summary panel receives generated markdown
 * instead, so it is not a consumer of this. */
declare function buildSummary(options: CliOptions, result: {
    output?: string;
    action: string;
    changed: boolean;
    markdown: string;
    itemCount: number;
    bytes: number;
}, output?: string | undefined, selectionReport?: ChangelogSelectionReport): Record<string, unknown>;
/**
 * OPT-OUT (`--no-check-diff` suppresses): when `--check` fails, show WHAT
 * drifted, not just THAT it drifted.
 *
 * The failure line alone forces the reader - usually a CI agent that cannot
 * rerun the generator interactively - to clone the repo and diff generator
 * output by hand; the common cause (a PR branch behind `main`, so the merge ref
 * sees a release commit the branch lacks) is obvious from the diff in seconds.
 * Check mode never writes, so the file on disk is still the committed
 * changelog. Stderr only: stdout stays byte-identical for callers that capture
 * it.
 */
declare function writeCheckDiff(options: CliOptions, outputPath: string, generated: string): void;
/** Print `--explain` diagnostics to stderr: how many items each filter stage
 * dropped, and how the survivors' release placement was dated. Stderr keeps
 * stdout byte-identical for callers capturing generated markdown. */
declare function writeSelectionReport(report: ChangelogSelectionReport): void;
/** Append the run summary as `key=value` step outputs for a workflow to branch
 * on, failing loudly when invoked outside GitHub Actions. */
declare function writeGitHubOutput(summary: Record<string, unknown>): void;
/** Append generated markdown to the workflow's job summary panel, so release
 * notes are readable in the run without downloading an artifact. */
declare function writeGitHubStepSummary(markdown: string): void;
/** Read a flag's value, rejecting a missing one and a following `--flag`. The
 * latter catches an omitted value being silently swallowed by the next flag. */
declare function requireValue(args: string[], index: number, flag: string): string;
/** Read a flag's value allowing a leading `--`, for flags whose argument may
 * legitimately look like one. */
declare function requireAnyValue(args: string[], index: number, flag: string): string;
/** Write the usage text listing every supported flag. */
declare function printHelp(): void;
/** Internal behavior surface used by in-process black-box coverage tests. */
export declare const cliTestSurface: {
    applyReleaseContext: typeof applyReleaseContext;
    buildGenerationOptions: typeof buildGenerationOptions;
    buildSummary: typeof buildSummary;
    editDistance: typeof editDistance;
    errorMessage: typeof errorMessage;
    loadItems: typeof loadItems;
    main: typeof main;
    normalizeArgs: typeof normalizeArgs;
    optionToken: typeof optionToken;
    parseArgs: typeof parseArgs;
    parseBodyPreview: typeof parseBodyPreview;
    parseFormat: typeof parseFormat;
    parseGroupBy: typeof parseGroupBy;
    parseItemRefStyle: typeof parseItemRefStyle;
    parseLimit: typeof parseLimit;
    parseMode: typeof parseMode;
    parseSectionBy: typeof parseSectionBy;
    printHelp: typeof printHelp;
    readStdin: typeof readStdin;
    requireAnyValue: typeof requireAnyValue;
    requireValue: typeof requireValue;
    resolveOptionAlias: typeof resolveOptionAlias;
    suggestOption: typeof suggestOption;
    unknownOptionError: typeof unknownOptionError;
    writeCheckDiff: typeof writeCheckDiff;
    writeGitHubOutput: typeof writeGitHubOutput;
    writeGitHubStepSummary: typeof writeGitHubStepSummary;
    writeSelectionReport: typeof writeSelectionReport;
};
/**
 * Runs the CLI only when Node invoked this module as the entry script.
 *
 * @param argv - Process arguments used to identify and invoke the script.
 * @returns Whether this module was the direct entrypoint.
 */
export declare function runCliEntry(argv?: readonly string[]): Promise<boolean>;
/** Convert an unknown CLI failure into a stable human-readable message. */
declare function errorMessage(error: unknown): string;
export {};
//# sourceMappingURL=cli.d.ts.map