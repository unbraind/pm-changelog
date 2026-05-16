#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin } from "node:process";
import { generateChangelog, parsePmItemsJson, readPmItems } from "./generator.js";
async function main() {
    const options = parseArgs(process.argv.slice(2));
    const items = await loadItems(options);
    const markdown = generateChangelog({
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
    if (options.stdout) {
        process.stdout.write(markdown);
        return;
    }
    const outputPath = resolve(options.output);
    writeFileSync(outputPath, markdown, "utf-8");
    console.error(`Wrote ${outputPath}`);
}
function parseArgs(args) {
    const options = {
        output: "CHANGELOG.md",
        stdout: false,
        stdin: false,
        groupBy: "version",
        includeEmpty: false,
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
            case "--include-empty":
                options.includeEmpty = true;
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }
    return options;
}
async function loadItems(options) {
    if (options.stdin) {
        return parsePmItemsJson(await readStdin());
    }
    if (options.input) {
        return parsePmItemsJson(readFileSync(resolve(options.input), "utf-8"));
    }
    return readPmItems({ pmRoot: options.pmRoot });
}
function readStdin() {
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
function parseGroupBy(value) {
    if (value === "version" || value === "milestone")
        return value;
    throw new Error("--group-by must be 'version' or 'milestone'");
}
function requireValue(args, index, flag) {
    const value = args[index];
    if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}
function printHelp() {
    process.stdout.write(`pm-changelog

Generate CHANGELOG.md from pm-cli items.

Usage:
  pm-changelog [options]

Options:
  -o, --output <file>       Write changelog to a file (default: CHANGELOG.md)
      --stdout              Print markdown instead of writing a file
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
      --include-empty       Emit an empty release section when no items match
`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map