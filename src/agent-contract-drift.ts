import { encodeUnicodeOutput as encode, stringifyUnicodeOutput, normalizeUnicodeText, normalizeUnicodeOutput } from "./output-unicode.ts";
import { EXIT_CODE, PmCliError, listAllComplete, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { buildChangelogDocument, compareVersionStrings } from "./generator.ts";
import { isContractReleaseAfter, parseContractRelease as releaseVersion, parseContractReleaseHeading } from "./contract-versions.ts";
import type { ChangelogStatusContext, PmItem } from "./types.ts";

/** Stable, explicit identity and behavior; evidence is provenance rather than an assumption. */
export type AgentObligation = { id: string; evidence: string[] } &
  ({ assumption: string; commands: string[]; removed?: never } | { removed: true; assumption?: never; commands?: never });
/** Expected refusals carry a stable discriminator and public-safe recovery instructions. */
export class AgentContractDriftError extends PmCliError {
  /** Stable machine discriminator, independent of rendered wording. */
  declare readonly code: "invalid_drift_options" | "invalid_obligation" | "ambiguous_contract" | "invalid_drift_report";
  /** Actionable recovery without source prose or operator paths. */
  readonly remedy: string;
  /** Preserve nonzero expected-error semantics in the host and standalone CLI. */
  constructor(code: AgentContractDriftError["code"], remedy: string) {
    super(`${code}: ${remedy}`, EXIT_CODE.USAGE, { code, nextSteps: [remedy] });
    this.remedy = remedy;
  }
}

/** Bound work and output independently of the caller's static TypeScript types. */
const MAX_ROWS = 100_000;
/** One declaration contributes at most this many evidence IDs or command names. */
const MAX_DECLARATION_REFERENCES = 64;
/** A release-wide evidence union may contain every ID from every accepted declaration. */
const MAX_AGGREGATE_EVIDENCE = MAX_ROWS * MAX_DECLARATION_REFERENCES;
/** Invalid item-level facets and scanned records each contribute at most one omission. */
const MAX_OMISSIONS = MAX_ROWS * 2;
/** Reject non-objects and unexpected keys before interpreting a strict schema variant. */
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new AgentContractDriftError("invalid_obligation", "Use only the documented obligation fields; each declaration must be an object.");
  }
  return value as Record<string, unknown>;
}
/** Dense bounded arrays only: Array.every alone would accept holes. */
function array(value: unknown, max = MAX_ROWS): unknown[] {
  if (!Array.isArray(value) || value.length > max || Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))) {
    throw new AgentContractDriftError("invalid_obligation", "Use a dense array within the documented size limit.");
  }
  return value as unknown[];
}
/** Preserve valid Unicode and CRLF; replace lone code units within the UTF-8 byte bound. */
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) {
    throw new AgentContractDriftError("invalid_obligation", "Use nonblank text within the documented UTF-8 byte limit.");
  }
  return normalizeUnicodeText(value);
}
/** Canonicalize set-valued declarations without changing command spellings or authored prose. */
function strings(value: unknown, max: number, bytes: number): string[] {
  return [...new Set(array(value, max).map((entry) => text(entry, bytes)))].sort();
}
/** The single strict declaration schema, shared by consumers and authoring producers.
 * Identity is package-wide and case-sensitive. No normalization is inferred from prose.
 */
export function parseAgentObligation(value: unknown): AgentObligation {
  const row = object(value, ["id", "assumption", "commands", "evidence", "removed"]);
  const id = text(row.id, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new AgentContractDriftError("invalid_obligation", "Use stable case-sensitive obligation IDs matching [A-Za-z0-9][A-Za-z0-9._:-]* (at most 160 bytes).");
  const evidence = strings(row.evidence, MAX_DECLARATION_REFERENCES, 256);
  if (!evidence.length) throw new AgentContractDriftError("invalid_obligation", "Declare at least one evidence ID, including for removals.");
  if (row.removed === true && row.assumption === undefined && row.commands === undefined) return { id, removed: true, evidence };
  if (row.removed !== undefined) throw new AgentContractDriftError("invalid_obligation", "A removal is exactly {id, removed: true, evidence}; active obligations omit removed.");
  const assumption = text(row.assumption, 8192), commands = strings(row.commands, MAX_DECLARATION_REFERENCES, 256);
  if (!commands.length) throw new AgentContractDriftError("invalid_obligation", "Declare at least one affected command for an active obligation.");
  return { id, assumption, commands, evidence };
}
/** Numeric stable releases only, with exact safe-integer components and daily suffixes. */
export function parseAgentContractRange(from: unknown, to: unknown): { from: string; to: string } {
  const low = releaseVersion(from), high = releaseVersion(to);
  if (!low || !high || compareVersionStrings(low, high) >= 0) throw new AgentContractDriftError("invalid_drift_options", "Provide --from below --to as stable numeric versions (for example 1.0.0 or 2026.10.28-1); no ranges, prereleases or build metadata.");
  return { from: low, to: high };
}
/** A definition appears once; rows below refer to its zero-based index. */
export interface AgentContractDefinition { id: string; assumption: string; commands: string[] }
/** Provenance belongs to each observation even when its assumption is unchanged. */
export interface AgentContractReference { release: string; ref: number; items: string[]; evidence: string[] }
/** Explicit state transitions retain both sides; removed commands remain reachable via before. */
export interface AgentContractChange {
  release: string; id: string; kind: "added" | "removed" | "changed";
  before: number | null; after: number | null; items: string[]; evidence: string[];
}
/** Per-record omissions never suppress a valid sibling declaration. */
export interface AgentContractOmission {
  item: string; facet: number | null; obligation: number | null;
  reason: "invalid_facets" | "missing_obligations" | "invalid_obligation" | "unversioned" | "orphan_removal";
}
/** Read-only comparison over (from,to], seeded with declarations at or before from. */
export interface AgentContractDriftOptions extends ChangelogStatusContext { items: PmItem[]; from: string; to: string }
/** Compact declared coverage, never an assertion that undeclared behavior stayed unchanged. */
export interface AgentContractDriftReport {
  schema_version: 1; from: string; to: string; complete: boolean;
  definitions: AgentContractDefinition[]; baseline: AgentContractReference[];
  changes: AgentContractChange[]; unchanged: AgentContractReference[]; omissions: AgentContractOmission[];
}
/** One release-local declaration after strict parsing and duplicate provenance consolidation. */
interface Observation {
  declaration: AgentObligation; release: string; items: Set<string>; evidence: Set<string>;
  sources: Omit<AgentContractOmission, "reason">[];
}

/** Serialize set-valued merged provenance once, preserving every accepted contributor. */
function provenance(entry: Observation): { items: string[]; evidence: string[] } {
  return { items: [...entry.items].sort(), evidence: [...entry.evidence].sort() };
}

/** Compare declared behavior, excluding provenance changes and never reading ordinary prose. */
function behavior(declaration: AgentObligation): string {
  return declaration.removed ? "removed" : JSON.stringify([declaration.assumption, declaration.commands]);
}
/** Build a deterministic delta index using the package's shared release and closure selection.
 * Absence is not removal. Same-release conflicting definitions refuse rather than invent an order.
 * Malformed records are omissions; valid sibling obligations still contribute.
 */
export function buildAgentContractDrift(options: AgentContractDriftOptions): AgentContractDriftReport {
  const range = parseAgentContractRange(options.from, options.to);
  const items = array(options.items);
  const byId = new Map<string, PmItem>();
  for (const value of items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentContractDriftError("invalid_drift_options", "Supply a complete tracker read with unique nonblank item IDs and text titles.");
    const source = value as PmItem;
    const item = { ...source, id: typeof source.id === "string" ? normalizeUnicodeText(source.id) : source.id };
    if (typeof item.id !== "string" || !item.id.trim() || typeof item.title !== "string" || byId.has(item.id)) throw new AgentContractDriftError("invalid_drift_options", "Supply a complete tracker read with unique nonblank item IDs and text titles.");
    byId.set(item.id, item);
  }
  const document = buildChangelogDocument({ items: [...byId.values()], groupBy: "release",
    statusRegistry: options.statusRegistry, statusSelection: options.statusSelection === undefined ? undefined : normalizeUnicodeOutput(new Map(options.statusSelection)),
    omittedNonChangeIds: options.omittedNonChangeIds === undefined ? undefined : normalizeUnicodeOutput(new Set(options.omittedNonChangeIds)) });
  const omissions: AgentContractOmission[] = [], observations = new Map<string, Map<string, Observation>>();
  let recordCount = 0;
  for (const release of document.releases) {
    if (isContractReleaseAfter(release.heading, range.to)) continue;
    const version = parseContractReleaseHeading(release.heading);
    for (const section of release.sections) for (const selected of section.items) {
      const item = byId.get(selected.id!)!;
      if (item.change_facets === undefined) continue;
      let facets: unknown[];
      try { facets = array(item.change_facets, 256); }
      catch { omissions.push({ item: item.id!, facet: null, obligation: null, reason: "invalid_facets" }); continue; }
      recordCount += facets.length;
      if (recordCount > MAX_ROWS) throw new AgentContractDriftError("invalid_drift_options", "Index at most 100000 facets and declarations per request; narrow the source tracker selection.");
      for (let facet = 0; facet < facets.length; facet++) {
        const raw = facets[facet];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) { omissions.push({ item: item.id!, facet, obligation: null, reason: "invalid_facets" }); continue; }
        const row = raw as Record<string, unknown>;
        if (row.audience !== "agent-behavior") continue;
        if (!version) { omissions.push({ item: item.id!, facet, obligation: null, reason: "unversioned" }); continue; }
        if (row.obligations === undefined) { omissions.push({ item: item.id!, facet, obligation: null, reason: "missing_obligations" }); continue; }
        let declarations: unknown[];
        try { declarations = array(row.obligations, 256); }
        catch { omissions.push({ item: item.id!, facet, obligation: null, reason: "invalid_obligation" }); continue; }
        for (let obligation = 0; obligation < declarations.length; obligation++) {
          if (++recordCount > MAX_ROWS) throw new AgentContractDriftError("invalid_drift_options", "Index at most 100000 facets and declarations per request; narrow the source tracker selection.");
          let declaration: AgentObligation;
          try { declaration = parseAgentObligation(declarations[obligation]); }
          catch { omissions.push({ item: item.id!, facet, obligation, reason: "invalid_obligation" }); continue; }
          const catalog = observations.get(version) ?? new Map<string, Observation>();
          observations.set(version, catalog);
          const previous = catalog.get(declaration.id);
          if (previous && behavior(previous.declaration) !== behavior(declaration)) throw new AgentContractDriftError("ambiguous_contract", "Give each obligation one behavior per release; separate conflicting declarations into different releases or distinct stable IDs.");
          if (previous) {
            previous.items.add(item.id!);
            for (const evidence of declaration.evidence) previous.evidence.add(evidence);
            previous.sources.push({ item: item.id!, facet, obligation });
          } else catalog.set(declaration.id, { declaration, release: version, items: new Set([item.id!]), evidence: new Set(declaration.evidence), sources: [{ item: item.id!, facet, obligation }] });
        }
      }
    }
  }
  const report: AgentContractDriftReport = { schema_version: 1, ...range, complete: true, definitions: [], baseline: [], changes: [], unchanged: [], omissions };
  const active = new Map<string, Observation>(), definitions = new Map<string, number>();
  /** Intern exact normalized definitions once, including reintroduced older definitions. */
  const reference = (entry: Observation): AgentContractReference => {
    const declaration = entry.declaration;
    const key = JSON.stringify([declaration.id, behavior(declaration)]);
    let ref = definitions.get(key);
    if (ref === undefined) {
      ref = report.definitions.length;
      definitions.set(key, ref);
      report.definitions.push({ id: declaration.id, assumption: declaration.assumption!, commands: declaration.commands! });
    }
    return { release: entry.release, ref, ...provenance(entry) };
  };
  const releases = [...observations.keys()].sort(compareVersionStrings);
  for (const release of releases) {
    if (compareVersionStrings(release, range.from) > 0) continue;
    for (const [id, entry] of observations.get(release)!) {
      if (entry.declaration.removed) active.delete(id); else active.set(id, entry);
    }
  }
  for (const id of [...active.keys()].sort()) report.baseline.push(reference(active.get(id)!));
  for (const release of releases) {
    if (compareVersionStrings(release, range.from) <= 0) continue;
    const catalog = observations.get(release)!;
    for (const id of [...catalog.keys()].sort()) {
      const entry = catalog.get(id)!, previous = active.get(id);
      if (entry.declaration.removed && !previous) {
        for (const source of entry.sources) omissions.push({ ...source, reason: "orphan_removal" });
        continue;
      }
      if (previous && behavior(previous.declaration) === behavior(entry.declaration)) {
        report.unchanged.push(reference(entry)); active.set(id, entry); continue;
      }
      const before = previous ? reference(previous).ref : null;
      const after = entry.declaration.removed ? null : reference(entry).ref;
      report.changes.push({ release, id, kind: entry.declaration.removed ? "removed" : previous ? "changed" : "added", before, after, ...provenance(entry) });
      if (entry.declaration.removed) active.delete(id); else active.set(id, entry);
    }
  }
  omissions.sort((a, b) => Number(JSON.stringify(a) > JSON.stringify(b)) - Number(JSON.stringify(a) < JSON.stringify(b)));
  report.complete = omissions.length === 0;
  return report;
}

/** Certified metadata and configured status roles use the supported SDK import, with no git path. */
export async function readAgentContractDrift(pmRoot: string, options: Omit<AgentContractDriftOptions, "items" | "statusRegistry">): Promise<AgentContractDriftReport> {
  parseAgentContractRange(options.from, options.to);
  const items = (await listAllComplete({ includeBody: false }, { pmRoot })).items;
  return buildAgentContractDrift({ ...options, items, statusRegistry: resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema) });
}

/** Validate emitted references and definitions with the declaration producer's strict schema. */
export function formatAgentContractDrift(report: AgentContractDriftReport, format: "json" | "toon"): string {
  try {
    object(report, ["schema_version", "from", "to", "complete", "definitions", "baseline", "changes", "unchanged", "omissions"]);
    parseAgentContractRange(report.from, report.to);
    if (report.schema_version !== 1 || typeof report.complete !== "boolean" || (format !== "json" && format !== "toon")) throw new Error();
    if (report.complete !== (array(report.omissions, MAX_OMISSIONS).length === 0)) throw new Error();
    const definitions = array(report.definitions);
    for (const value of definitions) {
      const definition = object(value, ["id", "assumption", "commands"]);
      parseAgentObligation({ ...definition, evidence: ["validation"] });
    }
    const validRef = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < definitions.length;
    for (const value of [...array(report.baseline), ...array(report.unchanged)]) {
      const row = object(value, ["release", "ref", "items", "evidence"]);
      if (!validRef(row.ref) || !releaseVersion(row.release)) throw new Error();
      strings(row.items, MAX_ROWS, Number.MAX_SAFE_INTEGER); strings(row.evidence, MAX_AGGREGATE_EVIDENCE, 256);
    }
    for (const value of array(report.changes)) {
      const row = object(value, ["release", "id", "kind", "before", "after", "items", "evidence"]);
      if (!releaseVersion(row.release) || typeof row.id !== "string"
        || !(row.kind === "added" && row.before === null && validRef(row.after)
          || row.kind === "removed" && validRef(row.before) && row.after === null
          || row.kind === "changed" && validRef(row.before) && validRef(row.after))) throw new Error();
      for (const ref of [row.before, row.after]) if (ref !== null && (definitions[Number(ref)] as AgentContractDefinition).id !== row.id) throw new Error();
      strings(row.items, MAX_ROWS, Number.MAX_SAFE_INTEGER); strings(row.evidence, MAX_AGGREGATE_EVIDENCE, 256);
    }
    for (const value of array(report.omissions, MAX_OMISSIONS)) {
      const row = object(value, ["item", "facet", "obligation", "reason"]);
      text(row.item, Number.MAX_SAFE_INTEGER);
      for (const position of [row.facet, row.obligation]) if (position !== null && (!Number.isSafeInteger(position) || Number(position) < 0 || Number(position) >= 256)) throw new Error();
      if (!["invalid_facets", "missing_obligations", "invalid_obligation", "unversioned", "orphan_removal"].includes(String(row.reason))) throw new Error();
    }
  } catch { throw new AgentContractDriftError("invalid_drift_report", "Rebuild the report through buildAgentContractDrift or readAgentContractDrift; do not edit definition references or emit nonfinite numbers."); }
  return `${format === "json" ? stringifyUnicodeOutput(report) : encode(report)}\n`;
}
