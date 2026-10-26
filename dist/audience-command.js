import { parseArgs } from "node:util";
import { resolvePmRoot } from "@unbrained/pm-cli/sdk";
import { AudienceContractError, formatAudienceContracts, parseChangeAudience, readAudienceContracts } from "./audience-contracts.js";
/** Shared host/standalone flags; all generation reads certified core metadata directly. */
export const AUDIENCE_CONTRACT_FLAGS = [
    { long: "--audience", value_name: "name", description: "api-user, operator or agent-behavior; default all three" },
    { long: "--format", value_name: "format", description: "toon (default) or compact json" },
    { long: "--group-by", value_name: "field", description: "version (default), release or milestone" },
    { long: "--section-by", value_name: "field", description: "category (default), type, status or label" },
    { long: "--release-version", value_name: "version", description: "Version heading for a single release" },
];
/** Validate command options before any read and use the same SDK report in both transports. */
export async function runAudienceContractsCommand(pmRoot, options, json = false) {
    const audience = options.audience === undefined ? undefined : parseChangeAudience(options.audience);
    const format = options.format ?? (json ? "json" : "toon");
    const groupBy = options["group-by"] ?? options.groupBy ?? "version";
    const sectionBy = options["section-by"] ?? options.sectionBy ?? "category";
    const version = options["release-version"] ?? options.releaseVersion;
    if ((format !== "json" && format !== "toon") || !["version", "release", "milestone"].includes(String(groupBy))
        || !["category", "type", "status", "label"].includes(String(sectionBy)) || (version !== undefined && typeof version !== "string")) {
        throw new AudienceContractError("invalid_contract_options", "Use --format toon|json, --group-by version|release|milestone, --section-by category|type|status|label and a text --release-version.");
    }
    const report = await readAudienceContracts(pmRoot, { audience, groupBy: groupBy, sectionBy: sectionBy, version });
    return formatAudienceContracts(report, format);
}
/** Standalone command parser, deliberately independent of git and markdown publication flags. */
export async function runAudienceContractsCli(args) {
    let values;
    try {
        values = parseArgs({ args, options: {
                "pm-root": { type: "string" }, audience: { type: "string" }, format: { type: "string" },
                "group-by": { type: "string" }, "section-by": { type: "string" }, "release-version": { type: "string" }, json: { type: "boolean" },
                help: { type: "boolean", short: "h" },
            } }).values;
    }
    catch {
        throw new AudienceContractError("invalid_contract_options", "Run pm-changelog contracts with --pm-root, --audience, --format, --group-by, --section-by or --release-version; each text flag needs a value.");
    }
    if (values.help) {
        process.stdout.write("pm-changelog contracts [--pm-root path] [--audience api-user|operator|agent-behavior]\n  [--format toon|json] [--json] [--group-by version|release|milestone]\n  [--section-by category|type|status|label] [--release-version version] [-h|--help]\nPublish only declared facets of closed changes; missing facets produce omissions. No git required.\n");
        return;
    }
    const root = resolvePmRoot(process.cwd(), values["pm-root"]);
    process.stdout.write(await runAudienceContractsCommand(root, values, values.json === true));
}
//# sourceMappingURL=audience-command.js.map