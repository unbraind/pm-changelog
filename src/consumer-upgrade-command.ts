import { parseArgs } from "node:util";
import { resolvePmRoot } from "@unbrained/pm-cli/sdk";
import { parseChangeAudience } from "./audience-contracts.ts";
import { ConsumerUpgradeError, formatConsumerUpgrades, readConsumerUpgrades } from "./consumer-upgrades.ts";

/** Shared host and standalone flags, with no apply or execution mode. */
export const CONSUMER_UPGRADE_FLAGS = [
  { long: "--audience", value_name: "name", description: "Required: api-user, operator or agent-behavior" },
  { long: "--from", value_name: "version", description: "Installed stable numeric version (exclusive)" },
  { long: "--to", value_name: "version", description: "Target stable numeric version (inclusive)" },
  { long: "--format", value_name: "format", description: "toon (default) or compact json" },
];

/** Validate transport flags and return the same read-only SDK report for both CLIs. */
export async function runConsumerUpgradesCommand(pmRoot: string, options: Record<string, unknown>, json = false): Promise<string> {
  const audience = parseChangeAudience(options.audience);
  const format = options.format ?? (json ? "json" : "toon");
  if ((format !== "json" && format !== "toon") || typeof options.from !== "string" || typeof options.to !== "string") {
    throw new ConsumerUpgradeError("invalid_upgrade_options", "Provide --audience, --from and --to; use --format toon|json. Run pm changelog upgrades --help for examples.");
  }
  return formatConsumerUpgrades(await readConsumerUpgrades(pmRoot, { audience, from: options.from, to: options.to }), format);
}

/** Parse standalone flags without generation flags, subprocesses or git discovery. */
export async function runConsumerUpgradesCli(args: string[]): Promise<void> {
  let values: Record<string, unknown>;
  try {
    values = parseArgs({ args, options: {
      "pm-root": { type: "string" }, audience: { type: "string" }, from: { type: "string" }, to: { type: "string" },
      format: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    } }).values;
  } catch {
    throw new ConsumerUpgradeError("invalid_upgrade_options", "Run pm-changelog upgrades --audience operator --from 1.0.0 --to 4.0.0 [--pm-root path] [--format toon|json] [--json]. Text flags need values.");
  }
  if (values.help) {
    process.stdout.write("pm-changelog upgrades --audience api-user|operator|agent-behavior --from version --to version\n  [--pm-root path] [--format toon|json] [--json] [-h|--help]\nCompile explicit breaking-facet obligations for (from,to] as pending core Plan step data. No execution or git required.\n");
    return;
  }
  process.stdout.write(await runConsumerUpgradesCommand(resolvePmRoot(process.cwd(), values["pm-root"] as string | undefined), values, values.json === true));
}
