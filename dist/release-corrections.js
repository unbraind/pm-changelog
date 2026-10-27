import { createHash } from "node:crypto";
import { encode } from "@toon-format/toon";
import { EXIT_CODE, PmCliError, PmClient, commitWorkspaceTransaction, deriveMutationTransactionId, readSettings, resolveRuntimeStatusRegistry } from "@unbrained/pm-cli/sdk";
import { DirectoryReleaseMilestoneStore, parseReleaseMilestone, readReleaseMilestones, resolveTrackerReleaseLedger } from "./milestones.js";
/** Expected failures retain stable codes and safe recovery instructions. */
export class ReleaseCorrectionError extends PmCliError {
    /** Public-safe corrective action for a refused operation. */
    remedy;
    /** Preserve expected-error behavior in the extension host and standalone CLI. */
    constructor(code, remedy) {
        super(`${code}: ${remedy}`, EXIT_CODE.USAGE, { code, nextSteps: [remedy] });
        this.remedy = remedy;
    }
}
/** Native structured context-event discriminator; other packages retain their own events. */
const EVENT_TYPE = "pm-changelog.release-correction";
const KEYS = ["schema", "release", "item", "milestone", "id", "supersedes", "expectedRevision", "wording", "evidence", "revision"];
/** Produce stable identity from a schema-ordered payload, without normalizing authored prose. */
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Share one strict bounded schema between producers, ingestion and persisted record validation. */
export function parseReleaseCorrection(value) {
    const refuse = () => { throw new ReleaseCorrectionError("correction_invalid", "Use schema 1 with release, item, milestone, id, supersedes, expectedRevision, wording and 1-16 evidence strings; read the current view for the target revision. No extra fields; prose is preserved, not trimmed."); };
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        return refuse();
    const row = value;
    const name = (entry) => typeof entry === "string" && entry === entry.trim() && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(entry);
    const hash = (entry) => typeof entry === "string" && entry.length === 64 && /^[a-f0-9]{64}$/.test(entry);
    const prose = (entry, max) => typeof entry === "string" && entry.length <= max && entry.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(entry)
        && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(entry);
    if (KEYS.slice(0, -1).some((key) => !Object.hasOwn(row, key)) || Object.keys(row).some((key) => !KEYS.includes(key)) || row.schema !== 1 || !name(row.release) || !name(row.item) || !name(row.id)
        || !(row.supersedes === "" || name(row.supersedes)) || !hash(row.milestone) || !hash(row.expectedRevision) || !prose(row.wording, 4000)
        || !Array.isArray(row.evidence) || row.evidence.length < 1 || row.evidence.length > 16
        || Array.from({ length: row.evidence.length }, (_, index) => index).some((index) => !Object.hasOwn(row.evidence, index))
        || Object.keys(row.evidence).length !== row.evidence.length || !row.evidence.every((entry) => prose(entry, 512)))
        return refuse();
    const input = { schema: 1, release: row.release, item: row.item, milestone: row.milestone, id: row.id,
        supersedes: row.supersedes, expectedRevision: row.expectedRevision, wording: row.wording, evidence: [...row.evidence] };
    const revision = digest(input);
    if (row.revision !== undefined && row.revision !== revision)
        return refuse();
    return { ...input, revision };
}
/** Serialize only schema-verified records; the exact output can be submitted again. */
export function formatReleaseCorrection(value, format = "toon") {
    const record = parseReleaseCorrection(value);
    return (format === "json" ? JSON.stringify(record) : encode(record)) + "\n";
}
/** Read the frozen claim and complete native annotations through the supported SDK. */
export async function readReleaseCorrectionView(pmRoot, release, item, options = {}) {
    // Validate selectors with the same schema before touching a backend.
    parseReleaseCorrection({ schema: 1, release, item, milestone: "0".repeat(64), id: "selector", supersedes: "", expectedRevision: "0".repeat(64), wording: "selector", evidence: ["selector"] });
    const store = options.milestones ?? new DirectoryReleaseMilestoneStore(pmRoot);
    const stored = await store.read(release);
    if (stored === undefined)
        throw new ReleaseCorrectionError("correction_missing", "Capture the named published milestone before correcting a claim.");
    const requested = parseReleaseMilestone(stored);
    const registry = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
    const claim = resolveTrackerReleaseLedger(await readReleaseMilestones(store), registry).claims.get(item);
    if (requested.name !== release || !claim || claim.milestone.name !== release || claim.milestone.fingerprint !== requested.fingerprint) {
        throw new ReleaseCorrectionError("correction_missing", "Use the item's first done-role release capture, not a later snapshot; inspect the milestone history to select the original published claim.");
    }
    const { milestone, item: frozen } = claim;
    parseReleaseCorrection({ schema: 1, release, item, milestone: milestone.fingerprint, id: "selector", supersedes: "", expectedRevision: milestone.fingerprint, wording: frozen.title, evidence: ["selector"] });
    const result = await new PmClient({ pmRoot }).notes(item, { limit: "10001", includeMeta: true, outputBudget: "unbounded", outputLimit: "unbounded" });
    const notes = requireCompleteNotes(result);
    const view = { schema: 1, release, item, milestone: milestone.fingerprint, original: frozen.title, current: frozen.title,
        revision: milestone.fingerprint, chain: [], skipped: { foreign: 0, invalid: 0, unrelated: 0 } };
    return projectCorrectionNotes(view, notes);
}
/** Consume an SDK completeness receipt before any row can influence a chain. */
function requireCompleteNotes(result) {
    if (!result.notes || result.read_output?.strings_compacted || result.read_output?.rows_compacted || result.has_more || result.notes.length > 10000)
        throw new ReleaseCorrectionError("correction_limit", "Read a claim with at most 10000 complete annotations; split future claims into separate published items.");
    return result.notes;
}
/** Project only owned valid events; a malformed record cannot poison its neighbors. */
function projectCorrectionNotes(view, notes) {
    const { release, item, milestone } = view;
    for (const note of notes) {
        const envelope = note.data;
        if (note.format !== "json" || !envelope || typeof envelope !== "object" || Array.isArray(envelope) || envelope.type !== EVENT_TYPE) {
            view.skipped.foreign++;
            continue;
        }
        let record;
        try {
            record = parseReleaseCorrection(envelope.correction);
        }
        catch {
            view.skipped.invalid++;
            continue;
        }
        if (record.release !== release || record.item !== item || record.milestone !== milestone) {
            view.skipped.unrelated++;
            continue;
        }
        if (view.chain.some((prior) => prior.id === record.id) || record.expectedRevision !== view.revision || record.supersedes !== (view.chain.at(-1)?.id ?? "")) {
            view.skipped.invalid++;
            continue;
        }
        if (view.chain.length === 256)
            throw new ReleaseCorrectionError("correction_limit", "Publish a new claim after 256 corrections; retain this historical chain.");
        view.chain.push(record);
        view.current = record.wording;
        view.revision = record.revision;
    }
    return view;
}
/** Revalidate the target or recognize an exact historical replay, never a saved-plan guess. */
function checkTarget(view, record) {
    if (record.milestone !== view.milestone)
        throw new ReleaseCorrectionError("correction_stale", "Read the immutable milestone fingerprint and current revision, then explicitly review the correction again.");
    const existing = view.chain.find((prior) => prior.id === record.id);
    if (existing?.revision === record.revision)
        return false;
    if (record.id === record.supersedes || (existing && view.chain.some((prior) => prior.id === record.supersedes))) {
        throw new ReleaseCorrectionError("correction_cycle", "Use a new correction id; an existing ancestor cannot supersede itself or a descendant.");
    }
    if (existing)
        throw new ReleaseCorrectionError("correction_conflict", "Keep the published correction unchanged; use a new id and link it to the current revision.");
    if (record.expectedRevision !== view.revision || record.supersedes !== (view.chain.at(-1)?.id ?? "")) {
        throw new ReleaseCorrectionError("correction_stale", "Read the current view and review the new wording against its latest revision and last correction id before retrying.");
    }
    const annotations = view.chain.length + view.skipped.foreign + view.skipped.invalid + view.skipped.unrelated;
    if (view.chain.length === 256 || annotations >= 10000)
        throw new ReleaseCorrectionError("correction_limit", "Publish a new claim after 256 corrections or 10000 annotations; retain this historical chain.");
    return true;
}
/** Append exactly one linked correction through the core journal and annotation primitive. */
export async function appendReleaseCorrection(pmRoot, input, options = {}) {
    const record = parseReleaseCorrection(input);
    const read = () => readReleaseCorrectionView(pmRoot, record.release, record.item, options);
    // Include the expected target revision, not wording alone, in transaction identity.
    const transactionId = `changelog-correction-${deriveMutationTransactionId(JSON.stringify(record))}`;
    const author = options.author ?? "pm-changelog";
    let changed = false;
    // Even committed-journal replays must inspect the current SDK state.
    checkTarget(await read(), record);
    await commitWorkspaceTransaction({ pmRoot, transactionId, author, onTransition: options.onTransition, steps: [{
                id: "append-correction",
                async inspect() { return { state: checkTarget(await read(), record) ? "pending" : "applied", result: record.revision }; },
                async apply() {
                    if (checkTarget(await read(), record)) {
                        const result = await new PmClient({ pmRoot, author }).notes(record.item, { addJson: JSON.stringify({ type: EVENT_TYPE, correction: record }), ifAbsent: true });
                        changed = result.changed === true;
                    }
                    return record.revision;
                },
                // Corrections are immutable assertions; interruption is recovered by inspection.
                async compensate() { },
            }] });
    const view = await read();
    if (!view.chain.some((prior) => prior.revision === record.revision)) {
        throw new ReleaseCorrectionError("correction_conflict", "The recorded correction is no longer intact; inspect native history and append an explicit new correction, never replay a frozen plan.");
    }
    return { changed, correction: record, view };
}
/** Validate all exposed counts and records before producing compact agent output. */
export function formatReleaseCorrectionView(view, format = "toon") {
    if (!Array.isArray(view.chain) || view.chain.length > 256 || Object.keys(view.chain).length !== view.chain.length
        || Array.from({ length: view.chain.length }, (_, index) => index).some((index) => !Object.hasOwn(view.chain, index))
        || [view.skipped.foreign, view.skipped.invalid, view.skipped.unrelated].some((count) => !Number.isSafeInteger(count) || count < 0 || count > 10000)) {
        throw new ReleaseCorrectionError("correction_invalid", "Return a bounded SDK correction view with dense records and finite nonnegative omission counts.");
    }
    const selector = parseReleaseCorrection({ schema: view.schema, release: view.release, item: view.item, milestone: view.milestone, id: "selector", supersedes: "", expectedRevision: view.revision, wording: view.original, evidence: ["selector"] });
    parseReleaseCorrection({ ...selector, wording: view.current, revision: undefined });
    const output = { schema: selector.schema, release: selector.release, item: selector.item, milestone: selector.milestone,
        original: view.original, current: view.current, revision: selector.expectedRevision, chain: view.chain.map(parseReleaseCorrection),
        skipped: { foreign: view.skipped.foreign, invalid: view.skipped.invalid, unrelated: view.skipped.unrelated } };
    return (format === "json" ? JSON.stringify(output) : encode(output)) + "\n";
}
/** Package-local pure boundary probes; SDK integration tests always use real trackers. */
export const releaseCorrectionTestSurface = { requireCompleteNotes, projectCorrectionNotes, checkTarget };
//# sourceMappingURL=release-corrections.js.map