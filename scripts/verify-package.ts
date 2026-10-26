/** Verify npm's actual file list and scan every packed member before release. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

/** Reject internal records, unexpected files and unsafe archive member names. */
export function allowedFile(file: string): boolean {
  if (file.split("/").some((part) => part === ".." || part === "")) return false;
  return file === "package.json" || /^licen[sc]e(?:\.[^/]+)?$/i.test(file)
    || PUBLIC_FILES.some((entry) => file === entry || (entry === "dist" && file.startsWith("dist/")));
}

/** npm pack's JSON output, limited to the fields this verifier consumes. */
interface PackResult {
  /** Generated archive basename. */
  filename: string;
  /** Paths reported by npm, relative to the package root. */
  files: { path: string }[];
}

/** Pack in isolation, verify actual membership, and scan each archive member. */
export function verifyPackage(root: string, dryRun = false): { files: number; failures: string[] } {
  const scratch = mkdtempSync(join(tmpdir(), "pm-changelog-pack-"));
  try {
    const args = ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch];
    if (dryRun) args.push("--dry-run");
    const output = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull },
      shell: process.platform === "win32",
    });
    const [pack] = JSON.parse(output) as PackResult[];
    if (!pack || pack.files.length === 0) throw new Error("npm pack returned no files");
    const failures: string[] = [];
    const archive = join(scratch, pack.filename);
    // Inspect the tar directory itself, not just npm's advertised file list.
    const files = dryRun ? pack.files.map(({ path }) => path) : execFileSync(
      "tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ).trimEnd().split("\n").map((name) => {
      if (!name.startsWith("package/")) throw new Error("unexpected archive root");
      return name.slice("package/".length);
    });
    if (files.length === 0) throw new Error("empty package archive");
    for (const file of files) {
      if (!allowedFile(file)) failures.push(`${file}: outside publication allowlist`);
      if (!dryRun) {
        const bytes = execFileSync("tar", ["-xOzf", archive, "--", `package/${file}`], { maxBuffer: 64 * 1024 * 1024 });
        for (const rule of contentFailures(bytes.toString("utf8"))) failures.push(`${file}: ${rule}`);
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
export function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const result = verifyPackage(resolve(import.meta.dirname, ".."), dryRun);
  for (const failure of result.failures) console.error(`FAIL: ${failure}`);
  console.log(`package ${dryRun ? "allowlist" : "content scan"}: ${result.files} files, ${result.failures.length} failures`);
  process.exitCode = result.failures.length === 0 ? 0 : 1;
}

if (isMainInvocation(process.argv, import.meta.url)) main();
