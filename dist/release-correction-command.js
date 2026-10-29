import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { encodeUnicodeOutput as encode, stringifyUnicodeOutput } from "./output-unicode.js";
import { resolvePmRoot } from "@unbrained/pm-cli/sdk";
import { ReleaseCorrectionError, appendReleaseCorrection, formatReleaseCorrectionView, readReleaseCorrectionView } from "./release-corrections.js";
/** Host and standalone transports share the same bounded file-ingestion options. */
export const RELEASE_CORRECTION_FLAGS = [
    { long: "--input", value_name: "file", description: "Append a correction from a JSON file (at most 128 KiB)" },
    { long: "--release", value_name: "name", description: "Published milestone to view" },
    { long: "--item", value_name: "id", description: "Published claim item to view" },
    { long: "--format", value_name: "format", description: "toon (default) or compact json" },
];
/** Read at most one bounded regular file; no unbounded file allocation or git lookup. */
async function readInput(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
        if (!(await handle.stat()).isFile())
            throw new Error("regular file required");
        const bytes = Buffer.alloc(131073);
        let length = 0;
        while (length < bytes.length) {
            const result = await handle.read(bytes, length, bytes.length - length, null);
            if (result.bytesRead === 0)
                break;
            length += result.bytesRead;
        }
        if (length > 131072)
            throw new Error("input too large");
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    }
    finally {
        await handle.close();
    }
}
/** Validate command selectors before touching storage, then delegate to the typed SDK surface. */
export async function runReleaseCorrectionsCommand(pmRoot, action, options, json = false, author) {
    const format = options.format ?? (json ? "json" : "toon");
    if ((format !== "json" && format !== "toon") || !["append", "view"].includes(action)
        || (action === "append" ? typeof options.input !== "string" || options.release !== undefined || options.item !== undefined
            : typeof options.release !== "string" || typeof options.item !== "string" || options.input !== undefined)) {
        throw new ReleaseCorrectionError("correction_invalid", "Use corrections append --input file.json, or corrections view --release name --item id; choose --format toon|json.");
    }
    if (action === "view")
        return formatReleaseCorrectionView(await readReleaseCorrectionView(pmRoot, options.release, options.item), format);
    let input;
    try {
        input = await readInput(options.input);
    }
    catch {
        throw new ReleaseCorrectionError("correction_invalid", "Read an accessible regular JSON correction file no larger than 128 KiB; see docs/release-corrections.md.");
    }
    const { changed, correction } = await appendReleaseCorrection(pmRoot, input, { author });
    const result = { changed, correction };
    return (format === "json" ? stringifyUnicodeOutput(result) : encode(result)) + "\n";
}
/** Parse standalone correction commands independently from historical generation flags. */
export async function runReleaseCorrectionsCli(args) {
    let parsed;
    try {
        parsed = parseArgs({ args, allowPositionals: true, options: {
                "pm-root": { type: "string" }, input: { type: "string" }, release: { type: "string" }, item: { type: "string" },
                format: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
            } });
    }
    catch {
        throw new ReleaseCorrectionError("correction_invalid", "Run pm-changelog corrections --help; text flags need values.");
    }
    if (parsed.values.help) {
        process.stdout.write("pm-changelog corrections append --input file.json [--pm-root path] [--format toon|json] [--json]\npm-changelog corrections view --release name --item id [--pm-root path] [--format toon|json] [--json] [-h|--help]\nAppend explicitly linked corrections to published milestone claims. Historical generation stays unchanged. No git required.\n");
        return;
    }
    if (parsed.positionals.length !== 1)
        throw new ReleaseCorrectionError("correction_invalid", "Select exactly one action: corrections append or corrections view.");
    const root = resolvePmRoot(process.cwd(), parsed.values["pm-root"]);
    process.stdout.write(await runReleaseCorrectionsCommand(root, parsed.positionals[0], parsed.values, parsed.values.json === true));
}
//# sourceMappingURL=release-correction-command.js.map