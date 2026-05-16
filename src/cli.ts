#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin } from "node:process";

import { createChangelog, mergeChangelog, parsePmItemsJson, readPmItems } from "./generator.js";
import type { PmItem } from "./types.js";

interface CliOptions {
  output: string;
  stdout: boolean;
  json: boolean;
  input?: string;
  stdin: boolean;
  pmRoot?: string;
  title?: string;
  version?: string;
  date?: string;
  since?: string;
  until?: string;
  statuses?: string[];
  groupBy: "version" | "milestone";
  includeEmpty: boolean;
  mode: "replace" | "prepend";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const items = await loadItems(options);
  const generated = createChangelog({
    items,
    title: options.title,
    version: options.version,
    date: options.date,
    since: options.since,
    until: options.until,
    includeStatuses: options.statuses,
    groupBy: options.groupBy,
    includeEmpty: options.includeEmpty,
  });
  const outputPath = resolve(options.output);
  const existing = options.mode === "prepend" && existsSync(outputPath)
    ? readFileSync(outputPath, "utf-8")
    : undefined;
  const merged = options.mode === "prepend"
    ? mergeChangelog(existing, generated.markdown, { title: options.title })
    : { markdown: generated.markdown, action: "replaced" as const, changed: true };

  if (options.stdout) {
    if (options.json) {
      process.stdout.write(JSON.stringify(buildSummary(options, generated.itemCount, merged)) + "\n");
      return;
    }
    process.stdout.write(merged.markdown);
    return;
  }

  writeFileSync(outputPath, merged.markdown, "utf-8");
  const summary = buildSummary(options, generated.itemCount, merged, outputPath);
  if (options.json) {
    process.stdout.write(JSON.stringify(summary) + "\n");
  } else {
    console.error(`Wrote ${outputPath}`);
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    output: "CHANGELOG.md",
    stdout: false,
    json: false,
    stdin: false,
    groupBy: "version",
    includeEmpty: false,
    mode: "replace",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      case "--output":
      case "-o":
        options.output = requireValue(args, ++i, arg);
        break;
      case "--stdout":
        options.stdout = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--input":
      case "-i":
        options.input = requireValue(args, ++i, arg);
        break;
      case "--stdin":
        options.stdin = true;
        break;
      case "--pm-root":
        options.pmRoot = requireValue(args, ++i, arg);
        break;
      case "--title":
        options.title = requireValue(args, ++i, arg);
        break;
      case "--version":
        options.version = requireValue(args, ++i, arg);
        break;
      case "--date":
        options.date = requireValue(args, ++i, arg);
        break;
      case "--since":
        options.since = requireValue(args, ++i, arg);
        break;
      case "--until":
        options.until = requireValue(args, ++i, arg);
        break;
      case "--status":
      case "--statuses":
        options.statuses = requireValue(args, ++i, arg)
          .split(",")
          .map((status) => status.trim())
          .filter(Boolean);
        break;
      case "--group-by":
        options.groupBy = parseGroupBy(requireValue(args, ++i, arg));
        break;
      case "--mode":
        options.mode = parseMode(requireValue(args, ++i, arg));
        break;
      case "--include-empty":
        options.includeEmpty = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function loadItems(options: CliOptions): Promise<PmItem[]> {
  if (options.stdin) {
    return parsePmItemsJson(await readStdin());
  }

  if (options.input) {
    return parsePmItemsJson(readFileSync(resolve(options.input), "utf-8"));
  }

  return readPmItems({ pmRoot: options.pmRoot });
}

function readStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    stdin.setEncoding("utf-8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolvePromise(data));
    stdin.on("error", reject);
  });
}

function parseGroupBy(value: string): "version" | "milestone" {
  if (value === "version" || value === "milestone") return value;
  throw new Error("--group-by must be 'version' or 'milestone'");
}

function parseMode(value: string): "replace" | "prepend" {
  if (value === "replace" || value === "prepend") return value;
  throw new Error("--mode must be 'replace' or 'prepend'");
}

function buildSummary(
  options: CliOptions,
  itemCount: number,
  merge: { action: string; changed: boolean; markdown: string },
  output?: string
): Record<string, unknown> {
  return {
    output,
    mode: options.mode,
    action: merge.action,
    changed: merge.changed,
    itemCount,
    bytes: Buffer.byteLength(merge.markdown, "utf-8"),
    markdown: options.stdout ? merge.markdown : undefined,
  };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  process.stdout.write(`pm-changelog

Generate CHANGELOG.md from pm-cli items.

Usage:
  pm-changelog [options]

Options:
  -o, --output <file>       Write changelog to a file (default: CHANGELOG.md)
      --stdout              Print markdown instead of writing a file
      --json                Print a JSON summary for CI/runners
  -i, --input <file>        Read pm JSON from a file instead of running pm
      --stdin               Read pm JSON from stdin
      --pm-root <dir>       pm project root for "pm --path <dir> list-all --json"
      --title <text>        Changelog title (default: Changelog)
      --version <version>   Version heading (default: Unreleased)
      --date <date>         Release date (default: today)
      --since <date>        Include items changed on or after this date
      --until <date>        Include items changed on or before this date
      --status <list>       Comma-separated statuses (default: closed)
      --group-by <mode>     version or milestone (default: version)
      --mode <mode>         replace or prepend existing changelog (default: replace)
      --include-empty       Emit an empty release section when no items match
`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
