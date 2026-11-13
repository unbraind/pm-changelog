import assert from "node:assert/strict";

/** A source-owned mutation and the expected real-tracker assertion failures. */
export interface EmptyUnreleasedMutation { name: string; from: string; to: string; failures: number }

/** Derive the exact seam from the generator being tested; missing/ambiguous
 * source is a proof failure, never an unreported skipped mutation. */
export function emptyUnreleasedMutation(source: string, name: string): EmptyUnreleasedMutation {
  const definitions: Record<string, { seam: RegExp; to: string; failures: number }> = {
    "restore-empty-Unreleased-visibility": { seam: /^ *\|\| \(options\.includeEmpty[^\r\n]+$/gm, to: "    || options.includeEmpty);", failures: 8 },
    "revert-prepend-cleanup": { seam: /^ *let next = [^\r\n]*omitEmptyUnreleasedSections\(existing\);$/gm, to: "  let next = existing;", failures: 2 },
    "drop-nonempty-Unreleased": { seam: /^ *const candidateSections = selectCandidateSections\(sections, options, renderingVersion\);$/gm, to: '  const candidateSections = selectCandidateSections(sections, options, renderingVersion).filter((section) => normalizeReleaseHeadingKey(section.heading) !== "unreleased");', failures: 2 },
    "drop-dependency-only-sections": { seam: /^ *\|\| \(section\.dependencyCommits\?\.length \?\? 0\) > 0$/gm, to: "    || false", failures: 2 },
  };
  assert.ok(Object.hasOwn(definitions, name), `Unknown proof mutation: ${name}`);
  const definition = definitions[name]!;
  const matches = [...source.matchAll(definition.seam)];
  assert.equal(matches.length, 1, `Missing or ambiguous generator seam for ${name}`);
  return { name, from: matches[0]![0], to: definition.to, failures: definition.failures };
}
