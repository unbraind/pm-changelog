import { encode } from "@toon-format/toon";
import { RelationshipGraph, analyzeRelationshipExecution, listAllComplete, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import type { PlanResultPlan, RelationshipEdge } from "@unbrained/pm-cli/sdk";
import { buildAudienceContracts, parseChangeAudience } from "./audience-contracts.ts";
import type { ChangeAudience } from "./audience-contracts.ts";
import { parseContractRelease, parseContractReleaseHeading } from "./contract-versions.ts";
import { compareVersionStrings } from "./generator.ts";
import type { ChangelogStatusContext, PmItem } from "./types.ts";
import { ConsumerUpgradeError, parseUpgradeActions } from "./upgrade-actions.ts";
import type { UpgradeAction } from "./upgrade-actions.ts";
export { ConsumerUpgradeError, parseUpgradeActions } from "./upgrade-actions.ts";
export type { ConsumerUpgradeErrorCode, UpgradeAction } from "./upgrade-actions.ts";

/** Reuse the public core Plan contract without owning a second step lifecycle. */
type CorePlanStep = NonNullable<PlanResultPlan["steps"]>[number];
/** One pending core Plan step plus its release provenance and prerequisite IDs. */
export interface ConsumerUpgradeStep extends UpgradeAction, Pick<CorePlanStep, "order" | "status"> {
  attribution: { item: string; release: string }[];
}
/** Installed version is exclusive; target version is inclusive. Both are explicit. */
export interface ConsumerUpgradeOptions extends ChangelogStatusContext {
  items: PmItem[];
  audience: ChangeAudience;
  from: string;
  to: string;
}
/** Read-only projection: no execution receipts, timestamps, target revisions or persisted state. */
export interface ConsumerUpgradeReport {
  schema_version: 1;
  audience: ChangeAudience;
  from: string;
  to: string;
  action_count: number;
  satisfied_prerequisites: string[];
  omissions: { item: string; release: string; reason: "missing_actions" }[];
  steps: ConsumerUpgradeStep[];
}
/** Accept stable numeric semver/calendar triplets and numeric daily disambiguators only. */
function version(value: unknown): string {
  const parsed = parseContractRelease(value);
  if (parsed === undefined) {
    throw new ConsumerUpgradeError("invalid_upgrade_options", "Use explicit stable numeric releases such as 1.2.0 or 2026.10.24-1; no ranges, prereleases or build metadata. Set from below to.");
  }
  return parsed;
}

/** Compile release obligations using core's ordering ontology and existing facet selection.
 * Repeated IDs must have identical definitions; earliest publication determines applicability.
 * Prerequisites published at/before the installed version are already satisfied. Other
 * prerequisites must be selected for this audience and interval. No source item is mutated.
 */
export function buildConsumerUpgrades(options: ConsumerUpgradeOptions): ConsumerUpgradeReport {
  const audience = parseChangeAudience(options.audience);
  const from = version(options.from), to = version(options.to);
  if (compareVersionStrings(from, to) >= 0) throw new ConsumerUpgradeError("invalid_upgrade_options", "Choose an installed --from version strictly below the target --to version.");
  const contracts = buildAudienceContracts({ items: options.items, audience, groupBy: "release", untilVersion: to, statusRegistry: options.statusRegistry, statusSelection: options.statusSelection, omittedNonChangeIds: options.omittedNonChangeIds });
  const items = new Map(options.items.map((item) => [item.id!, item]));
  const catalog = new Map<string, { action: UpgradeAction; introduced: string; attribution: ConsumerUpgradeStep["attribution"] }>();
  const omissions: ConsumerUpgradeReport["omissions"] = [];
  for (const row of contracts.ledger) {
    const item = items.get(row.item)!;
    for (const facet of item.change_facets ?? []) {
      if (facet.audience !== audience || !facet.breaking) continue;
      // Facets without published numeric release attribution cannot become upgrade obligations.
      const release = version(parseContractReleaseHeading(row.release));
      const actions = parseUpgradeActions(facet.upgrade_actions, facet.breaking);
      if (!actions.length && compareVersionStrings(release, from) > 0 && compareVersionStrings(release, to) <= 0) {
        omissions.push({ item: row.item, release, reason: "missing_actions" });
      }
      for (const action of actions) {
        const previous = catalog.get(action.id);
        if (previous && JSON.stringify(previous.action) !== JSON.stringify(action)) {
          throw new ConsumerUpgradeError("ambiguous_upgrade_action", `Give action ${action.id} a distinct audience-wide ID, or make its repeated title, body and prerequisites identical.`);
        }
        const entry = previous ?? { action, introduced: release, attribution: [] };
        if (compareVersionStrings(release, entry.introduced) < 0) entry.introduced = release;
        if (!entry.attribution.some((ref) => ref.item === row.item)) entry.attribution.push({ item: row.item, release });
        catalog.set(action.id, entry);
      }
    }
  }
  const selected = [...catalog.values()].filter((entry) => compareVersionStrings(entry.introduced, from) > 0 && compareVersionStrings(entry.introduced, to) <= 0);
  const edges: RelationshipEdge[] = [];
  const satisfied = new Set<string>();
  for (const { action } of selected) {
    for (const prerequisite of action.requires) {
      const target = catalog.get(prerequisite);
      if (!target || compareVersionStrings(target.introduced, to) > 0) {
        throw new ConsumerUpgradeError("missing_prerequisite", `Declare prerequisite ${prerequisite} required by ${action.id} for the selected audience in a closed, published breaking facet at or before --to; correct the reference or widen the target version.`);
      }
      if (compareVersionStrings(target.introduced, from) <= 0) satisfied.add(prerequisite);
      else if (prerequisite === action.id) throw new ConsumerUpgradeError("upgrade_cycle", `Remove the self-dependency on ${action.id} from authored upgrade_actions.requires before compiling again.`);
      else edges.push({ source: action.id, target: prerequisite, kind: "DEPENDS_ON" });
    }
  }
  const analysis = analyzeRelationshipExecution(new RelationshipGraph(selected.map(({ action }) => action.id), edges));
  if (!analysis.acyclic) throw new ConsumerUpgradeError("upgrade_cycle", `Remove cycles ${JSON.stringify(analysis.cycles)} from authored upgrade_actions.requires before compiling again.`);
  const steps = analysis.order.map((id, index): ConsumerUpgradeStep => {
    const entry = catalog.get(id)!;
    return { ...entry.action, order: index + 1, status: "pending", attribution: entry.attribution.filter((ref) => compareVersionStrings(ref.release, to) <= 0).sort((a, b) => a.item < b.item ? -1 : Number(a.item > b.item)) };
  });
  return { schema_version: 1, audience, from, to, action_count: steps.length, satisfied_prerequisites: [...satisfied].sort(), omissions, steps };
}

/** Read certified complete native metadata through the backend-aware SDK; never invoke git. */
export async function readConsumerUpgrades(pmRoot: string, options: Omit<ConsumerUpgradeOptions, "items">): Promise<ConsumerUpgradeReport> {
  const result = await listAllComplete({ includeBody: false }, { pmRoot });
  return buildConsumerUpgrades({ ...options, items: result.items, statusRegistry: resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema) });
}

/** Emit compact agent output without duplicating source prose or tracker state. */
export function formatConsumerUpgrades(report: ConsumerUpgradeReport, format: "json" | "toon"): string {
  return `${format === "json" ? JSON.stringify(report) : encode(report)}\n`;
}
