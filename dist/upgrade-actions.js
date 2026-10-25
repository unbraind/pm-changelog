import { EXIT_CODE, PmCliError } from "@unbrained/pm-cli/sdk";
/** Expected usage failure with an actionable, public-safe remedy. */
export class ConsumerUpgradeError extends PmCliError {
    /** Corrective action that can be shown without leaking tracker contents. */
    remedy;
    /** Preserve the host's nonzero expected-error behavior. */
    constructor(code, remedy) {
        super(`${code}: ${remedy}`, EXIT_CODE.USAGE, { code, nextSteps: [remedy] });
        this.remedy = remedy;
    }
}
/** Validate declarations without normalizing authored title/body whitespace. */
export function parseUpgradeActions(value, breaking) {
    const refuse = () => { throw new ConsumerUpgradeError("invalid_upgrade_actions", "Set breaking: true on the facet and upgrade_actions to an array of {id, title, requires: []}, with optional body. Use nonblank title/body and IDs matching [A-Za-z0-9][A-Za-z0-9._:-]*; no command or extra fields."); };
    if (value === undefined)
        return [];
    if (breaking !== true || !Array.isArray(value))
        return refuse();
    return value.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return refuse();
        const row = entry;
        const validId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id);
        if (Object.keys(row).some((key) => !["id", "title", "body", "requires"].includes(key)) || !validId(row.id)
            || typeof row.title !== "string" || !row.title.trim()
            || (row.body !== undefined && (typeof row.body !== "string" || !row.body.trim()))
            || !Array.isArray(row.requires) || !row.requires.every(validId))
            return refuse();
        return { id: row.id, title: row.title, ...(row.body === undefined ? {} : { body: row.body }), requires: [...new Set(row.requires)].sort() };
    });
}
//# sourceMappingURL=upgrade-actions.js.map