import { needsNeutralClosure } from "./closure-policy.ts";
import type { ChangelogStatusContext, PmItem } from "./types.ts";

/** Explicit observable SDK or CLI behavior change, with caller migration guidance. */
export interface ContractChange {
  api?: string;
  before: string;
  after: string;
  migrate: string;
}

/** Preserve incomplete historical declarations as auditable gaps, never inferred prose. */
export function readContractChange(item: PmItem): ContractChange | undefined {
  const direct = item.contract_change;
  const nested = item.metadata?.contract_change;
  const value = (direct === undefined || direct === null) && nested !== undefined ? nested : direct;
  if (value === undefined) return undefined;
  const row = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const before = contractText(row.before);
  const after = contractText(row.after);
  const migrate = contractText(row.migrate);
  const api = contractText(row.api);
  return { ...(api ? { api } : {}), before, after, migrate };
}

/** Share the renderer's declaration eligibility with every consumer of published claims. */
export function readPresentedContractChange(item: PmItem, context: ChangelogStatusContext): ContractChange | undefined {
  return needsNeutralClosure(item, context) ? undefined : readContractChange(item);
}

/** Trim authored text while treating absent or malformed fields as missing evidence. */
function contractText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
