import { EXIT_CODE, PmCliError } from "@unbrained/pm-cli/sdk";
import type { PlanResultPlan } from "@unbrained/pm-cli/sdk";

/** Explicit inert instructions reuse the public core Plan prose contract. */
export interface UpgradeAction extends Pick<NonNullable<PlanResultPlan["steps"]>[number], "id" | "title" | "body"> {
  requires: string[];
}
/** Stable refusal discriminator shared by the SDK and both command transports. */
export type ConsumerUpgradeErrorCode = "invalid_upgrade_options" | "invalid_upgrade_actions" | "ambiguous_upgrade_action" | "missing_prerequisite" | "upgrade_cycle";
/** Expected usage failure with an actionable, public-safe remedy. */
export class ConsumerUpgradeError extends PmCliError {
  /** Stable machine-readable refusal independent of rendered text. */
  declare readonly code: ConsumerUpgradeErrorCode;
  /** Corrective action that can be shown without leaking tracker contents. */
  readonly remedy: string;
  /** Preserve the host's nonzero expected-error behavior. */
  constructor(code: ConsumerUpgradeErrorCode, remedy: string) {
    super(`${code}: ${remedy}`, EXIT_CODE.USAGE, { code, nextSteps: [remedy] });
    this.remedy = remedy;
  }
}

/** Validate declarations without normalizing authored title/body whitespace. */
export function parseUpgradeActions(value: unknown, breaking: unknown): UpgradeAction[] {
  const refuse = (): never => { throw new ConsumerUpgradeError("invalid_upgrade_actions", "Set breaking: true on the facet and upgrade_actions to an array of {id, title, requires: []}, with optional body. Use nonblank title/body and IDs matching [A-Za-z0-9][A-Za-z0-9._:-]*; no command or extra fields."); };
  if (value === undefined) return [];
  if (breaking !== true || !Array.isArray(value)) return refuse();
  return (value as unknown[]).map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return refuse();
    const row = entry as Record<string, unknown>;
    const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id);
    if (Object.keys(row).some((key) => !["id", "title", "body", "requires"].includes(key)) || !validId(row.id)
      || typeof row.title !== "string" || !row.title.trim()
      || (row.body !== undefined && (typeof row.body !== "string" || !row.body.trim()))
      || !Array.isArray(row.requires) || !row.requires.every(validId)) return refuse();
    return { id: row.id, title: row.title, ...(row.body === undefined ? {} : { body: row.body as string }), requires: [...new Set(row.requires as string[])].sort() };
  });
}
