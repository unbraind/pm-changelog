import { escapeString } from "@toon-format/toon";
import { normalizeUnicodeOutput, encodeUnicodeOutput } from "./output-unicode.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createChangelog } from "./generator.js";
import { hasRepairEvidence, recordsDelivery } from "./closure-policy.js";
/** Stable diagnostics and recovery guidance for each absent evidence dimension. */
export const CLAIM_AUDIT_REMEDIES = {
    resolution: "Record the delivered outcome in close_reason or resolution.",
    tests: "Link a test command or test path to the item.",
    test_result: "Supply a passing receipt matching a linked command or path; retain its evidence reference.",
    delivery: "Record an affirmative merged/delivered PR or commit reference.",
    repair: "Record repair evidence or regenerate the claim with neutral Closed wording.",
    dependency: "Audit dependency delivery with pm-ops; commit subjects alone do not prove publication.",
};
/** Typed fail-closed audit errors with a concrete recovery step. */
export class ClaimAuditError extends Error {
    exitCode = 1;
    code;
    remedy;
    report;
    /** Preserve the refusal code and optional complete gap report for automation. */
    constructor(code, remedy, report) {
        super(`${code}: ${remedy}`);
        this.name = "ClaimAuditError";
        this.code = code;
        this.remedy = remedy;
        this.report = report;
    }
}
/** Read optional external values without interpreting malformed records as evidence. */
function text(value) {
    return typeof value === "string" ? value.trim() : "";
}
/** Sort and deduplicate evidence with locale-independent UTF-16 ordering. */
function stable(values) {
    return [...new Set(values.filter(Boolean))].sort();
}
/** Extract meaningful linked field values, ignoring foreign or malformed records. */
function linked(value, keys) {
    if (!Array.isArray(value))
        return [];
    return stable(value.flatMap((entry) => {
        if (!entry || typeof entry !== "object")
            return [];
        const record = entry;
        return keys.map((key) => text(record[key]));
    }));
}
/** Validate receipts before accepting a caller's execution assertions. */
export function parseClaimTestReceipts(value) {
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        }
        catch {
            throw new ClaimAuditError("invalid_receipts", "Supply valid JSON containing an array of execution receipts.");
        }
    }
    if (!Array.isArray(value))
        throw new ClaimAuditError("invalid_receipts", "Supply an array of item, command, outcome and reference records.");
    const receipts = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object")
            throw new ClaimAuditError("invalid_receipts", "Each receipt needs item, command, outcome and reference.");
        const row = entry;
        if (!text(row.item) || !text(row.command) || !text(row.reference) || (row.outcome !== "passed" && row.outcome !== "failed")) {
            throw new ClaimAuditError("invalid_receipts", "Each receipt needs nonblank item, command, reference and outcome passed or failed.");
        }
        receipts.push({ item: text(row.item), command: text(row.command), outcome: row.outcome, reference: text(row.reference) });
    }
    return receipts;
}
/** Collect affirmative delivery records; mere links and factual closure are insufficient. */
function deliveries(item) {
    const prose = [item.close_reason, item.resolution, item.actual_result].map(text);
    const links = Array.isArray(item.links) ? item.links : [];
    for (const link of links) {
        if (typeof link === "string")
            prose.push(link);
        else if (link && typeof link === "object") {
            const row = link;
            prose.push(`${text(row.state)} ${text(row.relation)} ${text(row.url)}`.trim());
        }
    }
    return stable(prose.filter(recordsDelivery));
}
/** Map rendered claims without writes; tracker-only options never invoke git.
 * Receipts are caller assertions, not independently verified CI or publication proof.
 * A failed receipt for a command dominates passing receipts for that same command.
 */
export function auditChangelogClaims(options, testReceipts = []) {
    if (options.dependencyUpdates && (!options.gitCwd || spawnSync("git", ["-C", options.gitCwd, "rev-parse", "--git-dir"], { stdio: "ignore" }).status !== 0)) {
        throw new ClaimAuditError("git_required", "Dependency claim audit needs a git repository; use tracker-only audit without dependencyUpdates or --dependency-updates.");
    }
    const receipts = parseClaimTestReceipts(testReceipts);
    const evidence = new Map();
    const claims = [];
    const usedGaps = new Set();
    const seen = new Set();
    for (const item of options.items) {
        if (!text(item.id) || seen.has(item.id))
            throw new ClaimAuditError("ambiguous_items", "Give every input item a unique nonblank id, then regenerate the audit.");
        seen.add(item.id);
    }
    const generated = createChangelog(options, (source) => {
        const gaps = new Set();
        const ids = stable(source.items.map((item) => item.id));
        if (source.kind === "dependency")
            gaps.add("dependency");
        for (const item of source.items) {
            const id = item.id;
            let record = evidence.get(id);
            if (!record) {
                const matching = receipts.filter((receipt) => receipt.item === id);
                // Canonical serialization also removes duplicate receipts without trusting input order.
                const ordered = stable(matching.map((receipt) => JSON.stringify(receipt))).map((value) => JSON.parse(value));
                record = {
                    item: id,
                    resolution: stable([text(item.close_reason), text(item.resolution)]),
                    files: linked(item.files, ["path"]),
                    tests: linked(item.tests, ["command", "path"]),
                    test_receipts: ordered,
                    delivery: deliveries(item),
                };
                evidence.set(id, record);
            }
            if (source.kind === "contributors")
                continue;
            if (!record.resolution.length)
                gaps.add("resolution");
            if (!record.tests.length)
                gaps.add("tests");
            const passed = record.tests.length > 0 && record.tests.every((command) => record.test_receipts.some((receipt) => receipt.command === command && receipt.outcome === "passed")
                && !record.test_receipts.some((receipt) => receipt.command === command && receipt.outcome === "failed"));
            if (!passed)
                gaps.add("test_result");
            if (!record.delivery.length)
                gaps.add("delivery");
            if (source.category === "Fixed" && !hasRepairEvidence(item))
                gaps.add("repair");
        }
        const orderedGaps = [...gaps].sort();
        orderedGaps.forEach((gap) => usedGaps.add(gap));
        claims.push({ line: source.line, release: source.release, section: source.section, claim: source.claim, items: ids, gaps: orderedGaps });
    });
    const unsupported = claims.filter((claim) => claim.gaps.length > 0).length;
    return {
        schema_version: 1,
        markdown_sha256: createHash("sha256").update(generated.markdown).digest("hex"),
        claim_count: claims.length,
        unsupported_count: unsupported,
        ready: unsupported === 0,
        claims,
        evidence: [...evidence.values()].sort((a, b) => a.item < b.item ? -1 : 1),
        remedies: Object.fromEntries([...usedGaps].sort().map((gap) => [gap, CLAIM_AUDIT_REMEDIES[gap]])),
    };
}
/** Refuse publication while retaining all unsupported claims and their remedies. */
export function assertChangelogClaims(report) {
    if (!report.ready)
        throw new ClaimAuditError("unsupported_claims", "Resolve the report gaps and regenerate before publication.", report);
}
/** Compact JSON or TOON with one table row per claim and no repeated tracker bodies. */
export function formatClaimAudit(report, format) {
    report = normalizeUnicodeOutput(report);
    if (format === "json")
        return `${JSON.stringify(report)}\n`;
    const lines = [
        `schema_version: 1`, encodeUnicodeOutput({ markdown_sha256: report.markdown_sha256 }),
        `claim_count: ${report.claim_count}`, `unsupported_count: ${report.unsupported_count}`, `ready: ${report.ready}`,
        `claims[${report.claims.length}]{line,release,section,claim,items,gaps}:`,
    ];
    for (const row of report.claims) {
        lines.push(`  ${[row.line, row.release, row.section, row.claim, JSON.stringify(row.items), JSON.stringify(row.gaps)].map((value) => typeof value === "string" ? `"${escapeString(value)}"` : JSON.stringify(value)).join(",")}`);
    }
    // Nested evidence remains compact JSON scalars inside valid TOON, avoiding lossy CSV flattening.
    lines.push(`evidence[${report.evidence.length}]:`);
    for (const row of report.evidence)
        lines.push(`  - ${JSON.stringify(JSON.stringify(row))}`);
    lines.push(`remedies: ${JSON.stringify(JSON.stringify(report.remedies))}`);
    return `${lines.join("\n")}\n`;
}
//# sourceMappingURL=claim-audit.js.map