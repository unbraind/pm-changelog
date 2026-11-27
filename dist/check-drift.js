import { fromMarkdown } from "mdast-util-from-markdown";
/** An advisory for file checks whose versioned Markdown still matches. */
export const PENDING_ONLY_MESSAGE = "Drift classification: pending_only. Only Unreleased differs.";
/** Compare retained bytes first, then the effective document-scoped definitions.
 * A missing file must still be created, even for an empty release history. */
export function isPendingOnlyDrift(committed, generated, withoutPending) {
    if (committed === undefined)
        return false;
    const existing = withoutPending(committed);
    const candidate = withoutPending(generated);
    if (existing.markdown !== candidate.markdown)
        return false;
    const definitions = existing.linkedDefinitions();
    return definitions !== undefined && definitions === candidate.linkedDefinitions();
}
/** Choose an unused, one-code-unit marker so micromark's upper/lower folding
 * cannot turn dotless i into ASCII i. Reserve literal characters and numeric
 * references alike so restoring the parsed link values cannot alter input. */
function dotlessIMarker(markdown) {
    const literal = new Set(markdown);
    const encoded = new Set([...markdown.matchAll(/&#(x[\da-f]{1,6}|\d{1,7});/gi)]
        .map(([, digits]) => Number(/^x/i.test(digits) ? "0" + digits : digits)));
    for (let codePoint = 0xE000; codePoint <= 0xF8FF; codePoint++) {
        const marker = String.fromCharCode(codePoint);
        if (!literal.has(marker) && !encoded.has(codePoint))
            return marker;
    }
    return undefined;
}
/** Compare the first definition of each retained link or image reference.
 * Parse the whole input so definitions in pending, nested, or later blocks can
 * still resolve retained text. Walk in source order so the pending cursor only
 * advances. Definition layout and shadowed definitions have no link effect. */
export function retainedReferenceDefinitions(markdown, pending) {
    if (!markdown.includes("]:"))
        return "[]";
    const marker = markdown.includes("ı") ? dotlessIMarker(markdown) : "";
    if (marker === undefined)
        return undefined;
    const source = marker ? markdown.replaceAll("ı", marker) : markdown;
    const nodes = fromMarkdown(source).children.reverse();
    const firstDefinitions = new Map();
    const retainedLabels = new Set();
    let pendingIndex = 0;
    for (let node = nodes.pop(); node; node = nodes.pop()) {
        if (node.type === "definition" && !firstDefinitions.has(node.identifier)) {
            firstDefinitions.set(node.identifier, [node.url, node.title ?? null]);
        }
        if (node.type === "linkReference" || node.type === "imageReference") {
            const offset = node.position.start.offset;
            while (pending[pendingIndex] && pending[pendingIndex][1] <= offset)
                pendingIndex++;
            if (!pending[pendingIndex] || offset < pending[pendingIndex][0])
                retainedLabels.add(node.identifier);
        }
        if ("children" in node) {
            for (let index = node.children.length - 1; index >= 0; index--)
                nodes.push(node.children[index]);
        }
    }
    const restore = (value) => marker ? value.replaceAll(marker, "ı") : value;
    return JSON.stringify([...retainedLabels].map((label) => {
        const [url, title] = firstDefinitions.get(label);
        return [restore(label), restore(url), title === null ? null : restore(title)];
    }));
}
/** Canonicalize complete entry blocks within each heading-delimited section.
 * Keep section order, prose, spacing, duplicate entries and fenced code exact. */
function canonicalEntryOrder(markdown) {
    const lines = markdown.split("\n");
    const result = [];
    let entries = [];
    let slots = [];
    let fenced;
    /** Fill only entry slots; no entry can move across a section boundary. */
    const flush = () => {
        entries.sort();
        let index = 0;
        result.push(...slots.map((slot) => slot === null ? entries[index++] : slot));
        slots = [];
        entries = [];
    };
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
        if (fence) {
            if (!fenced)
                fenced = fence;
            else if (fence[0] === fenced[0] && fence.length >= fenced.length && /^ {0,3}(`+|~+)\s*$/.test(line))
                fenced = undefined;
            slots.push(line);
            continue;
        }
        if (!fenced && /^#{1,6}\s/.test(line))
            flush();
        if (fenced || !line.startsWith("- ")) {
            slots.push(line);
            continue;
        }
        const block = [line];
        while (index + 1 < lines.length) {
            let next = index + 1;
            while (next < lines.length && lines[next].trim() === "")
                next++;
            if (next === lines.length)
                break;
            const continuation = lines[next];
            const indented = /^(?: {2,}|\t)\S/.test(continuation);
            // Lazy paragraph continuation cannot cross a blank line or interrupting block.
            const lazy = next === index + 1 && !/^ {0,3}(?:[-+*]\s|1[.)]\s|#{1,6}(?:\s|$)|>|`{3,}|~{3,}|(?:[-*_]\s*){3,}$|<(?:!|\?|\/?(?:address|article|aside|blockquote|div|dl|fieldset|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|script|section|style|table|ul)\b))/i.test(continuation);
            if (!indented && !lazy)
                break;
            block.push(...lines.slice(index + 1, next + 1));
            index = next;
        }
        entries.push(block.join("\n"));
        slots.push(null);
    }
    flush();
    return result.join("\n");
}
/** Compare entry units without losing section boundaries or continuation prose. */
export function isEntryReorder(committed, generated) {
    return committed !== generated && canonicalEntryOrder(committed) === canonicalEntryOrder(generated);
}
/** An upgrade needs different revisions AND an exact previous-renderer match.
 * A current-version/manual/timestamp reorder supplies neither proof on its own. */
export function classifyCheckDrift(committed, generated, previous, revisions) {
    const upgrade = revisions.previous !== revisions.current && committed === previous();
    if (isEntryReorder(committed, generated))
        return upgrade ? "reorder_only" : "tracker_changed";
    return committed !== generated && upgrade ? "rendering_changed" : "tracker_changed";
}
/** Exact historical matches retain their upgrade evidence beyond the last release. */
export function diagnoseCheckDrift(committed, generated, current, comparisons) {
    if (committed !== generated) {
        for (const profile of comparisons) {
            if (profile.version !== current && committed === profile.render()) {
                return { classification: "rendering_changed", changedIn: profile.changedIn, comparedVersion: profile.version };
            }
        }
    }
    return { classification: "tracker_changed" };
}
/** Option spellings the native readers accept beyond a registered flag name, keyed by normalized form (excludeTagsOption). */
const OPTION_ALIASES = Object.freeze({ excludetags: "excludetag" });
/** Resolve host camel/kebab spellings through the command's actual flag registry.
 * Unknown host internals are not command flags. Canonical supplied keys win. */
export function canonicalRegenerationOptions(options, flags) {
    const names = new Map(flags.filter((flag) => flag.long).map((flag) => {
        const name = flag.long.replace(/^--/, "");
        return [name.replace(/[-_]/g, "").toLowerCase(), name];
    }));
    const result = Object.create(null);
    // Precedence matches the native readers: the registered spelling, then its camelCase form, then accepted aliases.
    const candidates = Object.entries(options).flatMap(([key, value]) => {
        const normalized = key.replace(/^--/, "").replace(/[-_]/g, "").toLowerCase();
        const alias = OPTION_ALIASES[normalized];
        const name = names.get(alias ?? normalized);
        return name && value !== undefined ? [{ name, value, rank: key === name ? 0 : alias ? 2 : 1 }] : [];
    }).sort((left, right) => left.rank - right.rank);
    for (const { name, value } of candidates) {
        if (Object.hasOwn(result, name))
            continue;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
            result[name] = value;
        else if (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
            result[name] = value.map(String);
    }
    return result;
}
/** Build from parsed flags, never process.argv or an inferred host entrypoint.
 * Equals syntax keeps leading-dash option values intact, notably --pm-arg pairs.
 * Receipts always include argv, and Windows text explicitly targets PowerShell. */
export function regenerationCommand(options, invocation, platform = process.platform) {
    const args = [];
    for (const [name, value] of Object.entries(options)) {
        if (name === "check" || name === "check-pending" || name === "github-output" || name === "github-step-summary" || value === undefined || value === false)
            continue;
        if (value === true)
            args.push(`--${name}`);
        else
            for (const entry of Array.isArray(value) ? value : [value])
                args.push(`--${name}=${entry}`);
    }
    const argv = [...invocation, ...args];
    const shell = platform === "win32" ? "powershell" : "posix";
    if (options.stdin === true)
        return { argv, input_required: true, shell,
            message: `Regeneration requires the same stdin input or original pipe. Rerun the original pipe without --check or --check-pending; regeneration argv ${JSON.stringify(argv)}.` };
    const command = shell === "powershell"
        ? "& " + argv.map((arg) => "'" + arg.replace(/'/g, "''") + "'").join(" ")
        : argv.map((arg) => /^[a-zA-Z0-9_./:=@,+-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\\''") + "'").join(" ");
    return { argv, command, input_required: false, shell,
        message: `Run ${command}${shell === "powershell" ? ` (PowerShell); argv ${JSON.stringify(argv)}` : ""}.` };
}
/** A tracker reorder is distinct from a proved upgrade, even with equal lines. */
export function trackerReorderExplanation(committed, generated) {
    return isEntryReorder(committed, generated)
        ? " Entry order differs without proof of a rendering-version upgrade; a completed_at edit or manual reorder can cause this."
        : "";
}
//# sourceMappingURL=check-drift.js.map