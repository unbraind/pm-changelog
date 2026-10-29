import { parseArgs } from "node:util";
import { resolvePmRoot } from "@unbrained/pm-cli/sdk";
import { AgentContractDriftError, formatAgentContractDrift, parseAgentContractRange, readAgentContractDrift } from "./agent-contract-drift.js";
/** Shared flags keep the host command and standalone parser aligned. */
export const AGENT_CONTRACT_DRIFT_FLAGS = [
    { long: "--from", value_name: "version", description: "Installed stable numeric version (exclusive)" },
    { long: "--to", value_name: "version", description: "Target stable numeric version (inclusive)" },
    { long: "--format", value_name: "format", description: "toon (default) or compact json" },
];
/** Validate guards before reading, then use the same projection for both transports. */
export async function runAgentContractDriftCommand(pmRoot, options, json = false) {
    const range = parseAgentContractRange(options.from, options.to);
    const format = options.format ?? (json ? "json" : "toon");
    if (format !== "json" && format !== "toon")
        throw new AgentContractDriftError("invalid_drift_options", "Use --format toon|json or --json.");
    return formatAgentContractDrift(await readAgentContractDrift(pmRoot, range), format);
}
/** Standalone command performs no subprocess, git discovery or tracker writes. */
export async function runAgentContractDriftCli(args) {
    let values;
    try {
        values = parseArgs({ args, options: {
                "pm-root": { type: "string" }, from: { type: "string" }, to: { type: "string" },
                format: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
            } }).values;
    }
    catch {
        throw new AgentContractDriftError("invalid_drift_options", "Run pm-changelog drift --from 1.0.0 --to 2.0.0 [--pm-root path] [--format toon|json] [--json]; text flags need values.");
    }
    if (values.help) {
        process.stdout.write("pm-changelog drift --from version --to version [--pm-root path] [--format toon|json] [--json] [-h|--help]\nIndex declared agent-behavior obligations over (from,to]; no prose inference, writes or git required.\n");
        return;
    }
    process.stdout.write(await runAgentContractDriftCommand(resolvePmRoot(process.cwd(), values["pm-root"]), values, values.json === true));
}
//# sourceMappingURL=agent-contract-command.js.map