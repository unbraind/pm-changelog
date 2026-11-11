import { relative } from "node:path";

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
    while (index + 1 < lines.length && /^(?: {2,}|\t)\S/.test(lines[index + 1]!)) block.push(lines[++index]!);
    entries.push(block.join("\n"));
    slots.push(null);
  }
  flush();
  return result.join("\n");
}

/** Classify an actual difference, checking pure section-local reordering before
 * exact equality with the preceding shared renderer on the same tracker.
 * A lazy previous rendering avoids extra generation for ordinary reorder drift. */
export function classifyCheckDrift(committed: string, generated: string, previous: () => string): CheckDriftClassification {
  if (committed !== generated && canonicalEntryOrder(committed) === canonicalEntryOrder(generated)) return "reorder_only";
  if (committed === previous()) return "rendering_changed";
  return "tracker_changed";
}

/** Reproduce the configured entrypoint and arguments, removing only the check
 * flag (never an option value). Wrapper scripts keep their own configuration. */
export function regenerationCommand(args: string[], valueOptions: ReadonlySet<string>, fallback: string[] = ["pm-changelog"]): string {
  const entrypoint = process.argv[1];
  const isScript = entrypoint && !/\.test\.[cm]?[jt]s$/.test(entrypoint);
  const invocation = isScript ? ["node", relative(process.cwd(), entrypoint)] : fallback;
  const source = isScript ? process.argv.slice(2) : args;
  const filtered: string[] = [];
  for (let index = 0; index < source.length; index++) {
    const arg = source[index]!;
    if (arg === "--check") continue;
    filtered.push(arg);
    if (valueOptions.has(arg) && index + 1 < source.length) filtered.push(source[++index]!);
  }
  return [...invocation, ...filtered].map((arg) => /^[a-zA-Z0-9_./:=@,+-]+$/.test(arg)
    ? arg : "'" + arg.replace(/'/g, "'\\''") + "'").join(" ");
}
