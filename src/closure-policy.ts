import type { PmItem } from "./types.ts";

const ISSUE_TYPES = new Set(["issue", "bug", "bugfix", "defect"]);
// Dispositions must lead the reason, optionally after a factual closure prefix.
// Incidental words in repair prose (e.g. "Fixed duplicate grouping") do not count.
const NON_CHANGE = /^(?:(?:closed|closing|resolved)(?:\s+on\s+github)?\s+(?:as\s+)?)?(?:not[ _-]planned|duplicate|invalid|won['’]?t[ _-]fix|wontfix|superseded|cannot[ _-]+reproduce)(?=\s*$|\s*[.;:,(—–-]|\s+(?:of|by|on|because|due\s+to|in\s+favou?r\s+of)\b)/i;
// Base-form verbs can describe instructions for future work, not completed repairs.
const REPAIR = /^(?:fixed|repaired|corrected)\b|^resolved\s+(?!(?:as|on|with|completed|closed|done)\b)\S|\b(?:was|were|is|are|has\s+been|have\s+been)\s+(?:fixed|repaired|corrected|resolved(?!\s+(?:as|on|with|completed|closed|done)\b))\b/i;
const NEGATED_REPAIR = /\b(?:unproven|unverified|pending|proposed|planned|unmerged)\b|\b(?:not|never|will(?:\s+be)?|to\s+be|cannot(?:\s+be)?|can['’]?t(?:\s+be)?|didn['’]?t|doesn['’]?t|without|(?:may|might|could|should|would|must)\s+(?:have\s+been|be))\s+(?:yet\s+)?(?:fix(?:ed)?|repair(?:ed)?|correct(?:ed)?|resolv(?:e|ed)|merged?|deliver(?:ed)?|ship(?:ped)?|land(?:ed)?)\b/i;
const DELIVERY = /\b(?:merged|delivered|shipped|landed)\b/i;
const DELIVERY_REF = /\b(?:PR|pull request)\s+#\d+\b|\bcommit\s+[a-f0-9]{7,40}\b|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/(?:pull\/\d+|commit\/[a-f0-9]{7,40}\b)|\bmerged\s+(?:(?:in|as|at|via)\s+)?(?:(?:[\w.-]+\/[\w.-]+)?#\d+\b|[a-f0-9]{7,40}\b)/i;

/** Only terminal issue-like types use the evidence gate; other types keep their rules. */
function isClosedIssue(item: PmItem): boolean {
  return String(item.status).trim().toLowerCase() === "closed"
    && ISSUE_TYPES.has(String(item.type).trim().toLowerCase());
}

/** Safely read optional prose supplied by tracker versions and caller JSON. */
function prose(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Explicit non-change dispositions override links and old repair evidence. */
export function isNonChangeClosure(item: PmItem): boolean {
  return String(item.status).trim().toLowerCase() === "closed"
    && [item.close_reason, item.resolution].some((value) => NON_CHANGE.test(prose(value)));
}

/** Match meaningful SDK linked file/test records, ignoring malformed or blank rows. */
function hasLinkedEvidence(value: unknown, keys: readonly string[]): boolean {
  return Array.isArray(value) && value.some((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    return keys.some((key) => prose(record[key]).length > 0);
  });
}

/** Recognize an affirmative delivery with a PR/commit reference, never a bare issue link. */
export function recordsDelivery(value: unknown): boolean {
  const text = prose(value);
  return !NEGATED_REPAIR.test(text) && DELIVERY.test(text) && DELIVERY_REF.test(text);
}

/** Read prose and structured integration links without treating a link as proof of merge. */
function hasDeliveryLink(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry: unknown) => {
    if (typeof entry === "string") return recordsDelivery(entry);
    if (!entry || typeof entry !== "object") return false;
    const record = entry as Record<string, unknown>;
    return recordsDelivery(`${prose(record.state)} ${prose(record.relation)} ${prose(record.url)}`);
  });
}

/** Tracker evidence sufficient to label an issue as a repair; no git access occurs. */
export function hasRepairEvidence(item: PmItem): boolean {
  return hasLinkedEvidence(item.files, ["path"])
    || hasLinkedEvidence(item.tests, ["command", "path"])
    || [item.close_reason, item.resolution].some((value) => {
      const text = prose(value);
      return REPAIR.test(text) && !NEGATED_REPAIR.test(text);
    })
    || [item.close_reason, item.resolution, item.actual_result].some(recordsDelivery)
    || hasDeliveryLink(item.links);
}

/** A factual closure without recorded repair evidence must use neutral wording. */
export function needsNeutralClosure(item: PmItem): boolean {
  return isClosedIssue(item) && !hasRepairEvidence(item);
}

/** Count explicit non-change closures across input before status/release narrowing. */
export function countNonChangeClosures(items: readonly PmItem[]): number {
  return items.filter(isNonChangeClosure).length;
}
