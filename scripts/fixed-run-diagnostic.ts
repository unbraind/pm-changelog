import { scanMutationSecrets } from "@unbrained/pm-cli/sdk";

/**
 * Name the child tests that failed, without checkout paths or environment.
 *
 * Spec and TAP reporters both print a failing test's title. A file-level load
 * failure has no title; its error code is the diagnosable substitute. Lines
 * that look like paths are dropped. Titles are sanitized before logging.
 */
export function fixedRunFailureSummary(output: string): string {
  const names = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const tap = line.match(/^not ok \d+ - (.+)$/);
    const spec = line.match(/^✖ (?!failing tests)(.+)$/);
    const candidate = tap?.[1] ?? spec?.[1].replace(/\s+\(\d+(?:\.\d+)?ms\)$/, "");
    if (candidate && !isPathLike(candidate)) names.add(redactTitle(candidate));
  }
  if (names.size > 0) return `failing tests: ${[...names].join("; ")}`;
  const codes = [...output.matchAll(/\b(ERR_[A-Z0-9_]+|SyntaxError)\b/g)]
    .map((match) => match[1])
    .filter((code) => code !== "ERR_TEST_FAILURE");
  const listed = [...new Set(codes)];
  return listed.length ? `failing tests: ${listed.join("; ")}` : "failing tests: unnamed";
}

/** Redact assignment values and credential-shaped text in a reporter title. */
function redactTitle(title: string): string {
  // Match shell-style assignment words and skip standalone quoted prose.
  const assignments = /(?<!\S)(?:([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s"'])*|"[^"]*"|'[^']*'|`[^`]*`)/g;
  const sanitized = title.replace(assignments, (word, name: string | undefined) => name ? `${name}=<redacted>` : word);
  if (scanMutationSecrets(sanitized).length === 0) return sanitized;

  // The guard reports findings without spans. Preserve prose around individual
  // tokens and mask the whole title if a remaining finding spans several words.
  const tokensRedacted = sanitized.replace(/\S+/g, (token) => scanMutationSecrets(token).length ? "<redacted>" : token);
  return scanMutationSecrets(tokensRedacted).length ? "<redacted>" : tokensRedacted;
}

/** Whether a reporter line names a file rather than a test. */
function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\") || /^[A-Za-z]:/.test(value) || value.endsWith(".ts") || value.endsWith(".js");
}
