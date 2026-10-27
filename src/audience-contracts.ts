import { createHash } from "node:crypto";
import { encode } from "@toon-format/toon";
import { EXIT_CODE, PmCliError, listAllComplete, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { buildChangelogDocument, resolveChangelogResolution } from "./generator.ts";
import type { GenerateChangelogOptions, PmItem } from "./types.ts";
import { parseUpgradeActions } from "./upgrade-actions.ts";
import type { UpgradeAction } from "./upgrade-actions.ts";

/** Explicit publishing targets, in canonical output order. */
export const CHANGE_AUDIENCES = ["api-user", "operator", "agent-behavior"] as const;
/** One supported consumer of a versioned change contract. */
export type ChangeAudience = typeof CHANGE_AUDIENCES[number];
/** Exact author-declared prose, or an explicit opt-in to existing resolution prose. */
export type ChangeFacet = { audience: ChangeAudience; breaking?: true; upgrade_actions?: UpgradeAction[] } & ({ text: string; source?: never } | { source: "close_reason"; text?: never });
/** Selection delegates to the existing generator; only closed change items are published. */
export interface AudienceContractOptions extends Pick<GenerateChangelogOptions,
  "items" | "version" | "groupBy" | "sectionBy" | "since" | "until" | "excludeTags" |
  "releaseWindows" | "releaseMembership" | "suppressedPendingRelease" | "limit" | "sinceVersion" | "respectItemRelease" | "statusRegistry" | "statusSelection" | "omittedNonChangeIds"> {
  audience?: ChangeAudience;
}
/** Shared, prose-free identity of one selected change in one release section. */
export interface ChangeAttribution { item: string; release: string; section: string }
/** Audience-visible notes and explicit omissions reference the shared ledger by zero-based index. */
export interface AudienceChangeContract {
  audience: ChangeAudience;
  notes: { attribution: number; text: string }[];
  omissions: { attribution: number; reason: "missing_facet" | "missing_resolution" }[];
}
/** Deterministic contract bundle; no clock, tracker bodies or other audience prose in its ledger. */
export interface AudienceContractReport {
  schema_version: 1;
  ledger_sha256: string;
  item_count: number;
  note_count: number;
  omission_count: number;
  ledger: ChangeAttribution[];
  contracts: AudienceChangeContract[];
}
/** Stable refusal codes and remedies are available through both SDK and CLI. */
export class AudienceContractError extends PmCliError {
  declare readonly code: "invalid_audience" | "invalid_facets" | "ambiguous_items" | "invalid_contract_options";
  readonly remedy: string;
  /** Retain expected-error semantics so the host exits nonzero instead of swallowing refusals. */
  constructor(code: AudienceContractError["code"], remedy: string) {
    super(`${code}: ${remedy}`, EXIT_CODE.USAGE, { code, nextSteps: [remedy] });
    this.remedy = remedy;
  }
}

/** Validate audience input without interpreting unknown spellings as all audiences. */
export function parseChangeAudience(value: unknown): ChangeAudience {
  if (!CHANGE_AUDIENCES.some((audience) => audience === value)) {
    throw new AudienceContractError("invalid_audience", "Choose api-user, operator or agent-behavior; omit audience to generate all three.");
  }
  return value as ChangeAudience;
}

/** Validate every declaration before projecting; malformed metadata never becomes inferred prose. */
function readFacets(value: unknown): ChangeFacet[] {
  if (value === undefined) return [];
  const refuse = (): never => { throw new AudienceContractError("invalid_facets", "Set change_facets to an array of {audience, text} or {audience, source: close_reason}, optionally with breaking: true and upgrade_actions; use nonblank text and no extra fields."); };
  if (!Array.isArray(value)) return refuse();
  return (value as unknown[]).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return refuse();
    const row = entry as Record<string, unknown>;
    const audience = parseChangeAudience(row.audience);
    if (Object.keys(row).some((key) => !["audience", "text", "source", "breaking", "upgrade_actions"].includes(key)) || (row.breaking !== undefined && row.breaking !== true)) return refuse();
    parseUpgradeActions(row.upgrade_actions, row.breaking);
    if (typeof row.text === "string" && row.text.trim() && row.source === undefined) return { audience, text: row.text };
    if (row.source === "close_reason" && row.text === undefined) return { audience, source: "close_reason" };
    return refuse();
  });
}

/** Compare canonical keys by UTF-16 code units, with a total -1/0/1 ordering. */
function compareCanonicalKeys(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}

/** Publish declared facets using the generator's release, section, closure and resolution policies.
 * Canonical identity is independent of the audience filter. Missing source prose never falls back
 * to an item's title. Source items are neither mutated nor treated as proof of actual deployment.
 */
export function buildAudienceContracts(options: AudienceContractOptions): AudienceContractReport {
  const audiences = options.audience === undefined ? CHANGE_AUDIENCES : [parseChangeAudience(options.audience)];
  const items = new Map<string, PmItem>();
  for (const item of options.items) {
    if (typeof item.id !== "string" || !item.id.trim() || items.has(item.id)) {
      throw new AudienceContractError("ambiguous_items", "Supply a complete tracker read with unique nonblank item IDs.");
    }
    items.set(item.id, item);
  }
  // Normalize input before selection too: generator presentation comparators must
  // never let tracker enumeration order decide release or group tie placement.
  const canonicalItems = [...items.values()].sort((left, right) => compareCanonicalKeys(left.id!, right.id!));
  const document = buildChangelogDocument({ ...options, items: canonicalItems, includeStatuses: undefined, entryFrom: "close_reason" });
  const ledger: ChangeAttribution[] = [];
  const contracts: AudienceChangeContract[] = audiences.map((audience) => ({ audience, notes: [], omissions: [] }));
  for (const release of document.releases) {
    for (const section of [...release.sections].sort((left, right) => compareCanonicalKeys(left.heading, right.heading))) {
      // Section headings and unique item IDs form the canonical contract key;
      // optional dates and prose never change the identity order within a release.
      for (const row of [...section.items].sort((left, right) => compareCanonicalKeys(left.id!, right.id!))) {
        const item = items.get(row.id!)!;
        const facets = readFacets(item.change_facets);
        const attribution = ledger.length;
        ledger.push({ item: row.id!, release: release.heading, section: section.heading });
        for (const contract of contracts) {
          const declared = facets.filter((facet) => facet.audience === contract.audience);
          if (!declared.length) contract.omissions.push({ attribution, reason: "missing_facet" });
          const notes = new Set<string>();
          let missingResolution = false;
          for (const facet of declared) {
            if (facet.source === "close_reason") {
              const resolution = resolveChangelogResolution(item);
              if (resolution === undefined) missingResolution = true;
              else notes.add(resolution);
            } else notes.add(facet.text);
          }
          for (const text of [...notes].sort()) contract.notes.push({ attribution, text });
          if (missingResolution) contract.omissions.push({ attribution, reason: "missing_resolution" });
        }
      }
    }
  }
  return {
    schema_version: 1,
    ledger_sha256: createHash("sha256").update(JSON.stringify(ledger)).digest("hex"),
    item_count: ledger.length,
    note_count: contracts.reduce((sum, contract) => sum + contract.notes.length, 0),
    omission_count: contracts.reduce((sum, contract) => sum + contract.omissions.length, 0),
    ledger, contracts,
  };
}

/** Read complete core metadata through the backend-aware SDK; this path never invokes git. */
export async function readAudienceContracts(pmRoot: string, options: Omit<AudienceContractOptions, "items"> = {}): Promise<AudienceContractReport> {
  const result = await listAllComplete({ includeBody: false }, { pmRoot });
  return buildAudienceContracts({ ...options, items: result.items, statusRegistry: resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema) });
}

/** Compact JSON or TOON tables, storing the shared attribution ledger exactly once. */
export function formatAudienceContracts(report: AudienceContractReport, format: "json" | "toon"): string {
  if (format === "json") return `${JSON.stringify(report)}\n`;
  return `${encode(report)}\n`;
}
