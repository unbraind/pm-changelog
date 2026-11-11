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
            if (next === lines.length || !/^(?: {2,}|\t)\S/.test(lines[next]))
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
/** Resolve host camel/kebab spellings through the command's actual flag registry.
 * Unknown host internals are not command flags. Canonical supplied keys win. */
export function canonicalRegenerationOptions(options, flags) {
    const names = new Map(flags.filter((flag) => flag.long).map((flag) => {
        const name = flag.long.replace(/^--/, "");
        return [name.replace(/[-_]/g, "").toLowerCase(), name];
    }));
    const result = Object.create(null);
    for (const [key, value] of Object.entries(options)) {
        const name = names.get(key.replace(/^--/, "").replace(/[-_]/g, "").toLowerCase());
        if (!name || value === undefined || (Object.hasOwn(result, name) && key !== name))
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
        if (name === "check" || value === undefined || value === false)
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
            message: `Regeneration requires the same stdin input or original pipe. Rerun the original pipe without --check; regeneration argv ${JSON.stringify(argv)}.` };
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