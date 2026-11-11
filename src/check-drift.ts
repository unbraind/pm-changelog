/** Failure categories describe observable output, never a successful check. */
export type CheckDriftClassification = "reorder_only" | "rendering_changed" | "tracker_changed";

/** Canonicalize complete entry blocks within each heading-delimited section.
 * Keep section order, prose, spacing, duplicate entries and fenced code exact. */
function canonicalEntryOrder(markdown: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let entries: string[] = [];
  let slots: (string | null)[] = [];
  let fenced: string | undefined;
  /** Fill only entry slots; no entry can move across a section boundary. */
  const flush = (): void => {
    entries.sort();
    let index = 0;
    result.push(...slots.map((slot) => slot === null ? entries[index++]! : slot));
    slots = [];
    entries = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (!fenced) fenced = fence;
      else if (fence[0] === fenced[0] && fence.length >= fenced.length && /^ {0,3}(`+|~+)\s*$/.test(line)) fenced = undefined;
      slots.push(line);
      continue;
    }
    if (!fenced && /^#{1,6}\s/.test(line)) flush();
    if (fenced || !line.startsWith("- ")) {
      slots.push(line);
      continue;
    }
    const block = [line];
    while (index + 1 < lines.length) {
      let next = index + 1;
      while (next < lines.length && lines[next]!.trim() === "") next++;
      if (next === lines.length || !/^(?: {2,}|\t)\S/.test(lines[next]!)) break;
      block.push(...lines.slice(index + 1, next + 1));
      index = next;
    }
    entries.push(block.join("\n"));
    slots.push(null);
  }
  flush();
  return result.join("\n");
}

/** Rendering revisions belonging to the two renderings being compared. */
export interface RenderingRevisions { current: string; previous: string }

/** Compare entry units without losing section boundaries or continuation prose. */
export function isEntryReorder(committed: string, generated: string): boolean {
  return committed !== generated && canonicalEntryOrder(committed) === canonicalEntryOrder(generated);
}

/** An upgrade needs different revisions AND an exact previous-renderer match.
 * A current-version/manual/timestamp reorder supplies neither proof on its own. */
export function classifyCheckDrift(committed: string, generated: string, previous: () => string, revisions: RenderingRevisions): CheckDriftClassification {
  const upgrade = revisions.previous !== revisions.current && committed === previous();
  if (isEntryReorder(committed, generated)) return upgrade ? "reorder_only" : "tracker_changed";
  return committed !== generated && upgrade ? "rendering_changed" : "tracker_changed";
}

/** One retained comparison profile with the upgrade that changed its output. */
export interface HistoricalRenderingComparison { version: string; changedIn: string; render: () => string }
/** Exact historical matches retain their upgrade evidence beyond the last release. */
export function diagnoseCheckDrift(committed: string, generated: string, current: string, comparisons: readonly HistoricalRenderingComparison[]): { classification: CheckDriftClassification; changedIn?: string; comparedVersion?: string } {
  if (committed !== generated) {
    for (const profile of comparisons) {
      if (profile.version !== current && committed === profile.render()) {
        return { classification: "rendering_changed", changedIn: profile.changedIn, comparedVersion: profile.version };
      }
    }
  }
  return { classification: "tracker_changed" };
}

/** Canonical parsed flags only; arrays retain repeated option/value pairs. */
export type RegenerationOptions = Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>;
/** A ready command or an explicit requirement to restore the original input. */
export interface RegenerationGuidance {
  argv: string[];
  command?: string;
  input_required: boolean;
  shell: "posix" | "powershell";
  message: string;
}

/** Resolve host camel/kebab spellings through the command's actual flag registry.
 * Unknown host internals are not command flags. Canonical supplied keys win. */
export function canonicalRegenerationOptions(options: Readonly<Record<string, unknown>>, flags: readonly { long?: string }[]): RegenerationOptions {
  const names = new Map(flags.filter((flag) => flag.long).map((flag) => {
    const name = flag.long!.replace(/^--/, "");
    return [name.replace(/[-_]/g, "").toLowerCase(), name];
  }));
  const result = Object.create(null) as Record<string, string | number | boolean | string[]>;
  for (const [key, value] of Object.entries(options)) {
    const name = names.get(key.replace(/^--/, "").replace(/[-_]/g, "").toLowerCase());
    if (!name || value === undefined || (Object.hasOwn(result, name) && key !== name)) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[name] = value;
    else if (Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string")) result[name] = value.map(String);
  }
  return result;
}

/** Build from parsed flags, never process.argv or an inferred host entrypoint.
 * Equals syntax keeps leading-dash option values intact, notably --pm-arg pairs.
 * Receipts always include argv, and Windows text explicitly targets PowerShell. */
export function regenerationCommand(options: RegenerationOptions, invocation: readonly string[], platform: NodeJS.Platform = process.platform): RegenerationGuidance {
  const args: string[] = [];
  for (const [name, value] of Object.entries(options)) {
    if (name === "check" || name === "github-output" || name === "github-step-summary" || value === undefined || value === false) continue;
    if (value === true) args.push(`--${name}`);
    else for (const entry of Array.isArray(value) ? value : [value]) args.push(`--${name}=${entry}`);
  }
  const argv = [...invocation, ...args];
  const shell = platform === "win32" ? "powershell" : "posix";
  if (options.stdin === true) return { argv, input_required: true, shell,
    message: `Regeneration requires the same stdin input or original pipe. Rerun the original pipe without --check; regeneration argv ${JSON.stringify(argv)}.` };
  const command = shell === "powershell"
    ? "& " + argv.map((arg) => "'" + arg.replace(/'/g, "''") + "'").join(" ")
    : argv.map((arg) => /^[a-zA-Z0-9_./:=@,+-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "'\\''") + "'").join(" ");
  return { argv, command, input_required: false, shell,
    message: `Run ${command}${shell === "powershell" ? ` (PowerShell); argv ${JSON.stringify(argv)}` : ""}.` };
}

/** A tracker reorder is distinct from a proved upgrade, even with equal lines. */
export function trackerReorderExplanation(committed: string, generated: string): string {
  return isEntryReorder(committed, generated)
    ? " Entry order differs without proof of a rendering-version upgrade; a completed_at edit or manual reorder can cause this."
    : "";
}
