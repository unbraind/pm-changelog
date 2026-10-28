import { encode } from "@toon-format/toon";
import { RelationshipGraph, analyzeRelationshipExecution, listAllComplete, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { buildAudienceContracts, parseChangeAudience } from "./audience-contracts.js";
import { compareVersionStrings } from "./generator.js";
import { ConsumerUpgradeError, parseUpgradeActions } from "./upgrade-actions.js";
export { ConsumerUpgradeError, parseUpgradeActions } from "./upgrade-actions.js";
/** Accept stable numeric semver/calendar triplets and numeric daily disambiguators only. */
function version(value) {
    if (typeof value !== "string" || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/.test(value)
        || value.replace(/^v/, "").split(/[.-]/).some((part) => !Number.isSafeInteger(Number(part)))) {
        throw new ConsumerUpgradeError("invalid_upgrade_options", "Use explicit stable numeric releases such as 1.2.0 or 2026.10.24-1; no ranges, prereleases or build metadata. Set from below to.");
    }
    return value.replace(/^v/, "");
}
/** Compile release obligations using core's ordering ontology and existing facet selection.
 * Repeated IDs must have identical definitions; earliest publication determines applicability.
 * Prerequisites published at/before the installed version are already satisfied. Other
 * prerequisites must be selected for this audience and interval. No source item is mutated.
 */
export function buildConsumerUpgrades(options) {
    const audience = parseChangeAudience(options.audience);
    const from = version(options.from), to = version(options.to);
    if (compareVersionStrings(from, to) >= 0)
        throw new ConsumerUpgradeError("invalid_upgrade_options", "Choose an installed --from version strictly below the target --to version.");
    const contracts = buildAudienceContracts({ items: options.items, audience, groupBy: "release", statusRegistry: options.statusRegistry, statusSelection: options.statusSelection, omittedNonChangeIds: options.omittedNonChangeIds });
    const items = new Map(options.items.map((item) => [item.id, item]));
    const catalog = new Map();
    const omissions = [];
    for (const row of contracts.ledger) {
        const item = items.get(row.item);
        for (const facet of item.change_facets ?? []) {
            if (facet.audience !== audience || !facet.breaking)
                continue;
            // Facets without published numeric release attribution cannot become upgrade obligations.
            const release = version(row.release);
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
                if (compareVersionStrings(release, entry.introduced) < 0)
                    entry.introduced = release;
                if (!entry.attribution.some((ref) => ref.item === row.item))
                    entry.attribution.push({ item: row.item, release });
                catalog.set(action.id, entry);
            }
        }
    }
    const selected = [...catalog.values()].filter((entry) => compareVersionStrings(entry.introduced, from) > 0 && compareVersionStrings(entry.introduced, to) <= 0);
    const edges = [];
    const satisfied = new Set();
    for (const { action } of selected) {
        for (const prerequisite of action.requires) {
            const target = catalog.get(prerequisite);
            if (!target || compareVersionStrings(target.introduced, to) > 0) {
                throw new ConsumerUpgradeError("missing_prerequisite", `Declare prerequisite ${prerequisite} required by ${action.id} for the selected audience in a closed, published breaking facet at or before --to; correct the reference or widen the target version.`);
            }
            if (compareVersionStrings(target.introduced, from) <= 0)
                satisfied.add(prerequisite);
            else if (prerequisite === action.id)
                throw new ConsumerUpgradeError("upgrade_cycle", `Remove the self-dependency on ${action.id} from authored upgrade_actions.requires before compiling again.`);
            else
                edges.push({ source: action.id, target: prerequisite, kind: "DEPENDS_ON" });
        }
    }
    const analysis = analyzeRelationshipExecution(new RelationshipGraph(selected.map(({ action }) => action.id), edges));
    if (!analysis.acyclic)
        throw new ConsumerUpgradeError("upgrade_cycle", `Remove cycles ${JSON.stringify(analysis.cycles)} from authored upgrade_actions.requires before compiling again.`);
    const steps = analysis.order.map((id, index) => {
        const entry = catalog.get(id);
        return { ...entry.action, order: index + 1, status: "pending", attribution: entry.attribution.filter((ref) => compareVersionStrings(ref.release, to) <= 0).sort((a, b) => a.item < b.item ? -1 : Number(a.item > b.item)) };
    });
    return { schema_version: 1, audience, from, to, action_count: steps.length, satisfied_prerequisites: [...satisfied].sort(), omissions, steps };
}
/** Read certified complete native metadata through the backend-aware SDK; never invoke git. */
export async function readConsumerUpgrades(pmRoot, options) {
    const result = await listAllComplete({ includeBody: false }, { pmRoot });
    return buildConsumerUpgrades({ ...options, items: result.items, statusRegistry: resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema) });
}
/** Emit compact agent output without duplicating source prose or tracker state. */
export function formatConsumerUpgrades(report, format) {
    return `${format === "json" ? JSON.stringify(report) : encode(report)}\n`;
}
//# sourceMappingURL=consumer-upgrades.js.map