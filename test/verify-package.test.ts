/** Regression coverage for publication boundaries and packed-content privacy. */
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { allowedFile, contentFailures, PUBLIC_FILES, verifyPackage } from "../scripts/verify-package.ts";

/** Root of this checkout, used only for reading the real package contract. */
const ROOT = resolve(import.meta.dirname, "..");

it("publishes exactly the reviewed user guides and examples in package.json", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[]; scripts: Record<string, string> };
  deepEqual(manifest.files, PUBLIC_FILES);
  match(manifest.scripts["release:check"], /npm run pack:dry-run && npm run pack:scan/);
});

for (const file of ["docs/certification.md", "docs/claim-audit-validation.md", "docs/receipt.md", ".agents/pm/items.toon", "test/example.ts", "dist/../private", "/absolute", "dist//bad"]) {
  it(`rejects unpublished member ${file}`, () => equal(allowedFile(file), false));
}

for (const file of ["dist/index.js", "dist/cli.js.map", "README.md", "package.json", "LICENSE", "LICENSE.md", "docs/claim-audit-example.md"]) {
  it(`accepts public member ${file}`, () => equal(allowedFile(file), true));
}

/** Synthetic sensitive strings are assembled to keep tracked source path-free. */
const sensitive: [string, string][] = [
  ["local scratch path", ["", "tmp", "claude-fixture", "heavy-gate.lock"].join("/")],
  ["local home path", ["", "home", "fixture", "project", "file"].join("/")],
  ["local home path", ["", "Users", "fixture", "project", "file"].join("/")],
  ["local Windows home path", ["C:", "Users", "fixture", "project"].join("\\")],
  ["local Windows home path", ["C:", "Users", "fixture", "project"].join("\\\\")],
  ["GitHub credential", "ghp_" + "x".repeat(36)],
  ["GitHub credential", "github_pat_" + "x".repeat(40)],
  ["npm credential", "npm_" + "x".repeat(36)],
  ["AWS access key", "AKIA" + "X".repeat(16)],
  ["Slack credential", "xoxb-" + "x".repeat(30)],
  ["private key", ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ")],
  ["JWT credential", ["eyJ" + "x".repeat(12), "eyJ" + "x".repeat(12), "x".repeat(12)].join(".")],
  ["assigned credential", 'api_key="' + "x".repeat(30) + '"'],
  ["assigned credential", '"password": "' + "x".repeat(30) + '"'],
  ["API secret key", "sk-proj-" + "x".repeat(30)],
  ["API secret key", "sk-ant-api03-" + "x".repeat(30)],
  ["bearer credential", "Bearer " + "x".repeat(30)],
  ["assigned credential", 'token="' + "x".repeat(30) + '"'],
];

for (const [index, [rule, value]] of sensitive.entries()) {
  it(`detects synthetic content ${index + 1}: ${rule}`, () => deepEqual(contentFailures(`before ${value} after`), [rule]));
}

it("accepts neutral paths, public links and short documented synthetic values", () => {
  deepEqual(contentFailures('<scratch>/heavy-gate.lock https://example.com/docs token=secret password=<password> docs/usage.md'), []);
});

/** Build a real npm package in a plain directory, with no git repository. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-changelog-pack-test-"));
  for (const file of [...PUBLIC_FILES.filter((file) => file !== "dist"), "dist/index.js", "dist/cli.js"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "public fixture\n");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pack-scan-fixture", version: "1.0.0", files: PUBLIC_FILES }));
  return root;
}

it("packs a non-git fixture, excludes internal records and scans runtime bytes as well as docs", () => {
  const root = fixture();
  try {
    writeFileSync(join(root, "docs/certification.md"), sensitive[0][1]);
    const clean = verifyPackage(root);
    deepEqual(clean.failures, []);
    equal(verifyPackage(root, true).files, clean.files);
    writeFileSync(join(root, "dist/index.js"), sensitive[1][1]);
    writeFileSync(join(root, "docs/usage.md"), sensitive[5][1]);
    deepEqual(verifyPackage(root).failures, [
      "dist/index.js: local home path", "docs/usage.md: GitHub credential",
    ]);
    // Reinstate the original broad directory publication: scan actual packed
    // certification bytes even though membership already fails the allowlist.
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pack-scan-fixture", version: "1.0.0", files: ["dist", "docs", "manifest.json", "README.md", "CHANGELOG.md"] }));
    const old = verifyPackage(root);
    ok(old.failures.includes("docs/certification.md: outside publication allowlist"));
    ok(old.failures.includes("docs/certification.md: local scratch path"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("executes the real release entry point and scans the checked-out package", () => {
  const output = execFileSync(process.execPath, ["scripts/verify-package.ts"], { cwd: ROOT, encoding: "utf8" });
  match(output, /package content scan: \d+ files, 0 failures/);
});
