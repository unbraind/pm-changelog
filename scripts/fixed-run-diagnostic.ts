/**
 * Name the child tests that failed, without checkout paths or environment.
 *
 * Spec and TAP reporters both print a failing test's title. A file-level load
 * failure has no title; its error code is the diagnosable substitute. Lines
 * that contain a slash, backslash, or drive prefix are paths and are dropped
 * so a CI log cannot record a scratch directory or a private variable.
 */
export function fixedRunFailureSummary(output: string): string {
  const names = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const tap = line.match(/^not ok \d+ - (.+)$/);
    const spec = line.match(/^✖ (?!failing tests)(.+)$/);
    const candidate = tap?.[1] ?? spec?.[1].replace(/\s+\(\d+(?:\.\d+)?ms\)$/, "");
    if (candidate && !isPathLike(candidate)) names.add(candidate);
  }
  if (names.size > 0) return `failing tests: ${[...names].join("; ")}`;
  const codes = [...output.matchAll(/\b(ERR_[A-Z0-9_]+|SyntaxError)\b/g)]
    .map((match) => match[1])
    .filter((code) => code !== "ERR_TEST_FAILURE");
  const listed = [...new Set(codes)];
  return listed.length ? `failing tests: ${listed.join("; ")}` : "failing tests: unnamed";
}

/** Whether a reporter line names a file rather than a test. */
function isPathLike(value: string): boolean {
  return value.includes("/") || value.includes("\\") || /^[A-Za-z]:/.test(value) || value.endsWith(".ts") || value.endsWith(".js");
}
