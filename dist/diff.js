/**
 * Unified-diff rendering for `--check` drift reporting.
 *
 * `--check` is a mandatory CI gate across the fleet, and its failure output is
 * usually read by an agent that cannot rerun the generator interactively. A
 * bare "Changelog is out of date" line forces that reader to clone the repo
 * and diff generator output by hand; printing the actual drift — which entries
 * differ, in which section, in which direction — makes the common cause (a PR
 * branch behind `main`, so the CI merge ref sees a release commit the branch
 * lacks) obvious in seconds.
 *
 * The package ships zero runtime dependencies, so the diff is computed here
 * (a longest-common-subsequence pass over lines, with shared prefix/suffix
 * trimming) rather than pulled in from a new dependency.
 */
/** Default cap on emitted hunk lines. Exported so the `--check` truncation
 * notice can name the cap instead of hard-coding a second copy of the number. */
export const DEFAULT_MAX_DIFF_LINES = 200;
const DEFAULT_CONTEXT_LINES = 3;
/** Cell budget for the LCS table. Typical drift is a section or two after
 * prefix/suffix trimming, so the table stays tiny; the budget only guards the
 * pathological case (two large, mostly disjoint changelogs), where a
 * non-minimal block-replace hunk is an acceptable fallback because the output
 * is capped anyway. 4M cells ≈ 16 MiB as a Uint32Array. */
const MAX_LCS_CELLS = 4_000_000;
/**
 * Render a unified diff between two texts, line-oriented, with labeled sides
 * and a hard cap on emitted hunk lines. Exists so `--check` can show WHAT
 * drifted, not just THAT it drifted, without adding a runtime dependency.
 */
export function createUnifiedDiff(oldText, newText, options = {}) {
    const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
    const maxLines = options.maxLines ?? DEFAULT_MAX_DIFF_LINES;
    const hunks = buildHunks(computeOps(splitLines(oldText), splitLines(newText)), contextLines);
    if (hunks.length === 0) {
        return { text: "", truncated: false, omittedLines: 0 };
    }
    const body = [];
    for (const hunk of hunks) {
        body.push(`@@ -${formatRange(hunk.oldStart, hunk.oldCount)} +${formatRange(hunk.newStart, hunk.newCount)} @@`);
        for (const entry of hunk.lines) {
            body.push((entry.op === "delete" ? "-" : entry.op === "insert" ? "+" : " ") + entry.line);
        }
    }
    const truncated = body.length > maxLines;
    const emitted = truncated ? body.slice(0, maxLines) : body;
    const header = [`--- ${options.oldLabel ?? "old"}`, `+++ ${options.newLabel ?? "new"}`];
    return {
        text: [...header, ...emitted].join("\n") + "\n",
        truncated,
        omittedLines: body.length - emitted.length,
    };
}
function splitLines(text) {
    // Drop one trailing newline: drift detection already normalizes the final
    // newline, so a missing one must not surface as a phantom blank diff line.
    const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
    return normalized === "" ? [] : normalized.split("\n");
}
function computeOps(oldLines, newLines) {
    // Changelog drift is overwhelmingly a localized change in an otherwise
    // identical file; trimming the shared edges keeps the LCS table small.
    let prefix = 0;
    while (prefix < oldLines.length
        && prefix < newLines.length
        && oldLines[prefix] === newLines[prefix]) {
        prefix++;
    }
    let suffix = 0;
    while (suffix < oldLines.length - prefix
        && suffix < newLines.length - prefix
        && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
        suffix++;
    }
    const middle = diffMiddle(oldLines.slice(prefix, oldLines.length - suffix), newLines.slice(prefix, newLines.length - suffix));
    return [
        ...oldLines.slice(0, prefix).map((line) => ({ op: "context", line })),
        ...middle,
        ...oldLines.slice(oldLines.length - suffix).map((line) => ({ op: "context", line })),
    ];
}
function diffMiddle(oldLines, newLines) {
    const rows = oldLines.length + 1;
    const cols = newLines.length + 1;
    if (rows * cols > MAX_LCS_CELLS) {
        // Fallback for huge disjoint inputs: one block-replace. Not a minimal
        // edit script, but honest unified-diff output, and the line cap keeps
        // only its head from being printed anyway.
        return [
            ...oldLines.map((line) => ({ op: "delete", line })),
            ...newLines.map((line) => ({ op: "insert", line })),
        ];
    }
    const table = new Uint32Array(rows * cols);
    for (let i = oldLines.length - 1; i >= 0; i--) {
        for (let j = newLines.length - 1; j >= 0; j--) {
            table[i * cols + j] = oldLines[i] === newLines[j]
                ? table[(i + 1) * cols + (j + 1)] + 1
                : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
        }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < oldLines.length && j < newLines.length) {
        if (oldLines[i] === newLines[j]) {
            ops.push({ op: "context", line: oldLines[i] });
            i++;
            j++;
        }
        else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
            ops.push({ op: "delete", line: oldLines[i] });
            i++;
        }
        else {
            ops.push({ op: "insert", line: newLines[j] });
            j++;
        }
    }
    while (i < oldLines.length) {
        ops.push({ op: "delete", line: oldLines[i] });
        i++;
    }
    while (j < newLines.length) {
        ops.push({ op: "insert", line: newLines[j] });
        j++;
    }
    return ops;
}
function buildHunks(ops, contextLines) {
    const changeIndices = [];
    for (const [index, entry] of ops.entries()) {
        if (entry.op !== "context")
            changeIndices.push(index);
    }
    if (changeIndices.length === 0)
        return [];
    // Expand each change by the context window and merge windows that touch,
    // so two edits separated by a few unchanged lines render as one hunk.
    const spans = [];
    let spanStart = Math.max(0, changeIndices[0] - contextLines);
    let spanEnd = Math.min(ops.length, changeIndices[0] + contextLines + 1);
    for (const changeIndex of changeIndices.slice(1)) {
        const start = Math.max(0, changeIndex - contextLines);
        const end = Math.min(ops.length, changeIndex + contextLines + 1);
        if (start <= spanEnd) {
            spanEnd = Math.max(spanEnd, end);
        }
        else {
            spans.push([spanStart, spanEnd]);
            spanStart = start;
            spanEnd = end;
        }
    }
    spans.push([spanStart, spanEnd]);
    // Old/new line numbers consumed before each op, for hunk headers.
    const oldBefore = new Array(ops.length + 1).fill(0);
    const newBefore = new Array(ops.length + 1).fill(0);
    for (const [index, entry] of ops.entries()) {
        oldBefore[index + 1] = oldBefore[index] + (entry.op === "insert" ? 0 : 1);
        newBefore[index + 1] = newBefore[index] + (entry.op === "delete" ? 0 : 1);
    }
    return spans.map(([start, end]) => {
        const lines = ops.slice(start, end);
        const oldCount = lines.filter((entry) => entry.op !== "insert").length;
        const newCount = lines.filter((entry) => entry.op !== "delete").length;
        return {
            oldStart: oldCount > 0 ? oldBefore[start] + 1 : oldBefore[start],
            oldCount,
            newStart: newCount > 0 ? newBefore[start] + 1 : newBefore[start],
            newCount,
            lines,
        };
    });
}
function formatRange(start, count) {
    // Unified-diff convention: ",1" is omitted.
    return count === 1 ? String(start) : `${start},${count}`;
}
//# sourceMappingURL=diff.js.map