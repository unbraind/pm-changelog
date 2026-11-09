/** Read the item's authored contract declaration: the one presentation policy
 * shared by Markdown, JSON, summary and audit. Every declaration of a rendered
 * item publishes; closure evidence still governs repair and semver classification.
 * Diagnostics describe only assertions the changelog claims. */
export function readContractChange(item) {
    const direct = item.contract_change;
    const nested = item.metadata?.contract_change;
    const value = (direct === undefined || direct === null) && nested !== undefined ? nested : direct;
    if (value === undefined)
        return undefined;
    const row = value !== null && typeof value === "object" && !Array.isArray(value)
        ? value : {};
    const before = contractText(row.before);
    const after = contractText(row.after);
    const migrate = contractText(row.migrate);
    const api = contractText(row.api);
    return { ...(api ? { api } : {}), before, after, migrate };
}
/** Trim authored text while treating absent or malformed fields as missing evidence. */
function contractText(value) {
    return typeof value === "string" ? value.trim() : "";
}
//# sourceMappingURL=contract-changes.js.map