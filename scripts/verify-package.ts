/** Verify npm's actual file list and scan every packed member before release. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isMainInvocation } from "./main-invocation.ts";

/** Deliberately reviewed publication surface, independent of npm's manifest. */
export const PUBLIC_FILES = [
  "dist", "docs/README.md", "docs/usage.md", "docs/release.md",
  "docs/development.md", "docs/tracker-milestones.md",
  "docs/claim-audit-example.md", "docs/consumer-upgrades.md",
  "docs/audience-contracts.md", "manifest.json", "README.md", "CHANGELOG.md",
] as const;

/** Rules report categories only: matched credentials must never enter logs. */
const CONTENT_RULES: readonly (readonly [string, RegExp])[] = [
  ["local scratch path", /\/tmp\/claude-[^\s"'<>`]+/i],
  ["local home path", /\/(?:home|Users)\/[^/\s"'<>`]+\//i],
  ["local Windows home path", /[a-z]:\\+Users\\+/i],
  ["GitHub credential", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["npm credential", /\bnpm_[A-Za-z0-9]{20,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Slack credential", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["API secret key", /\bsk-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{20,}\b/],
  ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/i],
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["JWT credential", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ["assigned credential", /(?:_authToken|_auth|api[_-]?key|(?:access[_-]?)?token|password|(?:client[_-]?)?secret)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_+\/-]{20,}/i],
];

/** Return rule names for sensitive bytes without disclosing their values. */
export function contentFailures(content: string): string[] {
  return CONTENT_RULES.filter(([, pattern]) => pattern.test(content)).map(([name]) => name);
}

/**
 * Redact every sensitive span with its whole path segment, preserving clean
 * context. Match all rules against the original text so overlapping rules cannot
 * hide one another; hash the removed bytes for stable, value-free identification.
 * Path mode includes whitespace/punctuation in the replaced segment. Text mode
 * preserves surrounding diagnostic prose. This is the sole redaction function
 * for results, logs and thrown errors.
 */
export function redactDiagnostic(text: string, path = false): string {
  const spans: { start: number; end: number; rule: string }[] = [];
  for (const [rule, pattern] of CONTENT_RULES) {
    // Lookahead finds overlapping matches too (a bearer value can consume the
    // prefix of another marker in the next path segment).
    for (const match of text.matchAll(new RegExp(`(?=(${pattern.source}))`, pattern.flags + "g"))) {
      let start = match.index;
      let end = start + match[1].length;
      const separator = path ? /[\/\\]/ : /[\/\\\s:"'<>`]/;
      while (start > 0 && !separator.test(text[start - 1])) start--;
      while (end < text.length && !separator.test(text[end])) end++;
      spans.push({ start, end, rule });
    }
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof spans = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  let result = "";
  let offset = 0;
  for (const { start, end, rule } of merged) {
    const hash = createHash("sha256").update(text.slice(start, end)).digest("hex").slice(0, 7);
    result += text.slice(offset, start) + `[redacted:${rule}#${hash}]`;
    offset = end;
  }
  return result + text.slice(offset);
}

/** Reject internal records, unexpected files and unsafe archive member names. */
export function allowedFile(file: string): boolean {
  if (file.split("/").some((part) => part === ".." || part === "")) return false;
  return file === "package.json" || /^licen[sc]e(?:\.[^/]+)?$/i.test(file)
    || PUBLIC_FILES.some((entry) => file === entry || (entry === "dist" && file.startsWith("dist/")));
}

/**
 * Capture child output without implicit stderr forwarding. Do not expose command
 * error objects or output excerpts: npm can truncate or escape sensitive values
 * before our rules see them. Only the fixed command label crosses this boundary.
 */
function packageCommand(program: "npm" | "tar", args: string[], root?: string): Buffer {
  const windowsNpm = program === "npm" && process.platform === "win32";
  try {
    return execFileSync(windowsNpm ? "npm.cmd" : program, args, {
      cwd: root, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull },
      shell: windowsNpm, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(redactDiagnostic(`${program} failed during package verification`));
  }
}

/** Decode tar's escape listing as UTF-8 bytes, including literal backslashes. */
function archiveName(escaped: string): string {
  const controls: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92 };
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const match of escaped.matchAll(/\\([0-7]{3}|[abfnrtv\\])/g)) {
    chunks.push(Buffer.from(escaped.slice(offset, match.index)));
    chunks.push(Buffer.from([controls[match[1]] ?? Number.parseInt(match[1], 8)]));
    offset = match.index + match[0].length;
  }
  chunks.push(Buffer.from(escaped.slice(offset)));
  return Buffer.concat(chunks).toString("utf8");
}

/** Pack in isolation, verify actual membership, and scan each archive member. */
export function verifyPackage(root: string, dryRun = false): { files: number; failures: string[] } {
  try {
    const result = scanPackage(root, dryRun);
    return { files: result.files, failures: result.failures.map((failure) => redactDiagnostic(failure)) };
  } catch (error) {
    // Do not retain child-process properties/cause or caller frames: argv,
    // buffers and URL-escaped frame paths can contain sensitive bytes.
    const safe = new Error(redactDiagnostic(error instanceof Error ? error.message : String(error)));
    safe.stack = redactDiagnostic(`${safe.name}: ${safe.message}`);
    throw safe;
  }
}

/** Scan original bytes and redact names before assembling diagnostic prose. */
function scanPackage(root: string, dryRun: boolean): { files: number; failures: string[] } {
  const scratch = mkdtempSync(join(tmpdir(), "pm-changelog-pack-"));
  try {
    packageCommand("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], root);
    // npm sanitizes some credential-shaped names in its JSON metadata. Inspect
    // the actual archive even in allowlist mode, which still skips file contents.
    const archives = readdirSync(scratch).filter((name) => name.endsWith(".tgz"));
    if (archives.length !== 1) throw new Error("npm pack did not produce exactly one archive");
    const failures: string[] = [];
    const archive = join(scratch, archives[0]);
    // Inspect the tar directory itself, not just npm's advertised file list.
    const files = packageCommand("tar", ["-tzf", archive]).toString("utf8").split("\n").slice(0, -1).map((escaped) => {
      const name = archiveName(escaped);
      if (!name.startsWith("package/")) throw new Error("unexpected archive root");
      return name.slice("package/".length);
    });
    if (files.length === 0) throw new Error("empty package archive");
    for (const file of files) {
      const name = redactDiagnostic(file, true);
      if (!allowedFile(file)) failures.push(`${name}: outside publication allowlist`);
      for (const rule of contentFailures(file)) failures.push(`${name}: member name: ${rule}`);
      if (!dryRun) {
        const bytes = packageCommand("tar", ["-xOzf", archive, "--", `package/${file}`]);
        for (const rule of contentFailures(bytes.toString("utf8"))) failures.push(`${name}: ${rule}`);
      }
    }
    for (const required of PUBLIC_FILES.filter((file) => file !== "dist")) {
      if (!files.includes(required)) failures.push(`${required}: required public file missing`);
    }
    if (!files.includes("dist/index.js") || !files.includes("dist/cli.js")) failures.push("built runtime missing");
    return { files: files.length, failures };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Run the release gate and report only safe file names and rule categories. */
export function main(root = resolve(import.meta.dirname, "..")): void {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const result = verifyPackage(root, dryRun);
    for (const failure of result.failures) console.error(redactDiagnostic(`FAIL: ${failure}`));
    console.log(redactDiagnostic(`package ${dryRun ? "allowlist" : "content scan"}: ${result.files} files, ${result.failures.length} failures`));
    process.exitCode = result.failures.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(redactDiagnostic(`FAIL: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
  }
}

if (isMainInvocation(process.argv, import.meta.url)) main();
