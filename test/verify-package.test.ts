/** Regression coverage for publication boundaries and packed-content privacy. */
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { allowedFile, contentFailures, PUBLIC_FILES, redactDiagnostic, verifyPackage } from "../scripts/verify-package.ts";

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

/** Assert the stronger substring property without echoing a failing marker. */
function noMarkers(output: string, markers: readonly string[]): void {
  for (const marker of markers) {
    for (let index = 0; index <= marker.length - 8; index++) {
      ok(!output.includes(marker.slice(index, index + 8)), "diagnostic leaked a synthetic marker substring");
    }
  }
}

/** Exercise actual stdout/stderr in a child, including implicit subprocess writes. */
function runMain(root: string, dryRun = false): string {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    'import { main } from "./scripts/verify-package.ts"; main(process.argv[1]);', root,
    ...(dryRun ? ["--dry-run"] : []),
  ], { cwd: ROOT, encoding: "utf8" });
  equal(child.status, 1);
  return child.stdout + child.stderr;
}

/** Generate independent credential markers at runtime, never tracked secrets. */
function credentialMarkers(): string[] {
  const value = randomBytes(24).toString("hex");
  return [
    "gh" + "p_" + value,
    "github" + "_pat_" + value,
    "np" + "m_" + value,
    "AK" + "IA" + randomBytes(8).toString("hex").toUpperCase(),
    "xo" + "xb-" + value,
    "s" + "k-proj-" + value,
    "s" + "k-ant-api03-" + value,
    "Bearer " + value,
    "Bearer\t" + value,
    "Bearer\n" + value,
    ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
    ["ey" + "J" + value, "ey" + "J" + value, value].join("."),
    "api" + "_key=" + value,
  ];
}

/** Keep clean identifiers outside the markers' hex alphabet to avoid collisions. */
function cleanIdentifier(): string {
  return Array.from(randomBytes(12), (byte) => String.fromCharCode(103 + byte % 20)).join("");
}

it("redacts all occurrences and overlapping rules with stable whole-segment placeholders", () => {
  for (let iteration = 0; iteration < 30; iteration++) {
    const markers = credentialMarkers();
    for (const marker of markers) {
      const text = `dist/prefix-${marker}.js/${marker}/clean.js: excerpt ${marker}`;
      const safe = redactDiagnostic(text);
      noMarkers(safe, [marker]);
      match(safe, /^dist\/\[redacted:/);
      ok(safe.endsWith(": excerpt " + redactDiagnostic(marker)));
      equal(redactDiagnostic(text), safe);
      equal(redactDiagnostic(safe), safe);
    }
    // One segment can contain multiple overlapping/different credential rules.
    noMarkers(redactDiagnostic(`dist/${markers.join("-")}.js`), markers);
  }
  for (const [, marker] of sensitive) {
    ok(!redactDiagnostic(marker).includes(marker), "every scanner rule must redact its own values");
  }
  const clean = 'dist/ordinary-name.js docs/usage.md package.json: outside publication allowlist';
  equal(redactDiagnostic(clean), clean);
  match(redactDiagnostic(`dist/clean prefix ${credentialMarkers()[0]}.js`, true), /^dist\/\[redacted:GitHub credential#[a-f0-9]{7}\]$/);
  ok(redactDiagnostic("gh" + "p_" + "A".repeat(36)) !== redactDiagnostic("gh" + "p_" + "B".repeat(36)));
});

it("property: real archive names and contents cannot leak in human or JSON diagnostics", () => {
  const root = fixture();
  const markers: string[] = [];
  const cleanNames: string[] = [];
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pack-scan-fixture", version: "1.0.0", files: [...PUBLIC_FILES, "outside"] }));
    for (const directory of ["dist", "outside"]) {
      for (const position of ["directory", "basename", "extension"]) {
        for (const marker of credentialMarkers()) {
          const clean = cleanIdentifier();
          const relative = position === "directory" ? `${directory}/${marker}/${clean}.js`
            : position === "basename" ? `${directory}/${marker}-${clean}.js`
            : `${directory}/${clean}.${marker}`;
          const body = "Bearer " + randomBytes(24).toString("hex");
          markers.push(marker, body);
          mkdirSync(dirname(join(root, relative)), { recursive: true });
          writeFileSync(join(root, relative), body);
        }
      }
    }
    writeFileSync(join(root, "outside/clean-name.txt"), "neutral contents");
    writeFileSync(join(root, "dist/clean-runtime.js"), "neutral contents");
    for (let iteration = 0; iteration < 20; iteration++) {
      const suffix = ["", "\t", "\n", "\\", "\u0001", "é"][iteration % 6];
      const name = `outside/clean ${cleanIdentifier()}${suffix}.txt`;
      cleanNames.push(name);
      writeFileSync(join(root, name), "neutral contents");
      equal(redactDiagnostic(name, true), name);
    }
    for (const dryRun of [false, true]) {
      const result = verifyPackage(root, dryRun);
      noMarkers(result.failures.join("\n") + JSON.stringify(result), markers);
      equal(result.failures.filter((failure) => failure.includes(": member name:")).length, 78);
      ok(result.failures.includes("outside/clean-name.txt: outside publication allowlist"));
      ok(cleanNames.every((name) => result.failures.includes(`${name}: outside publication allowlist`)));
      ok(!result.failures.some((failure) => failure.includes("dist/clean-runtime.js")));
      noMarkers(runMain(root, dryRun), markers);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("issue 287: refuses a credential-shaped dist filename even with neutral contents", () => {
  const root = fixture();
  const name = "gh" + "p_" + "Z".repeat(36);
  const body = "Bearer " + "Q".repeat(30);
  const file = join(root, "dist", name + ".js");
  try {
    writeFileSync(file, body);
    const result = verifyPackage(root);
    noMarkers(JSON.stringify(result) + result.failures.join("\n") + runMain(root), [name, body]);
    equal(result.failures.length, 2);
    ok(result.failures.some((failure) => failure.includes(": member name: GitHub credential")));
    ok(result.failures.some((failure) => failure.endsWith(": bearer credential")));
    writeFileSync(file, "neutral contents");
    const neutral = verifyPackage(root);
    equal(neutral.failures.length, 1);
    noMarkers(JSON.stringify(neutral), [name]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("sanitizes thrown command errors and actual stderr including package metadata and root paths", () => {
  const parent = fixture();
  const markers = credentialMarkers().filter((marker) => !marker.includes(" "));
  const root = join(parent, markers[0]);
  try {
    mkdirSync(root);
    // Missing package: raw npm errors would contain the working path.
    let caught = false;
    try {
      verifyPackage(root);
    } catch (error) {
      caught = true;
      ok(error instanceof Error);
      noMarkers(String(error) + error.stack + JSON.stringify(error), markers);
      deepEqual(Object.keys(error), []);
    }
    ok(caught, "expected npm failure");
    noMarkers(runMain(root), markers);
    // Invalid metadata would make npm include the untrusted version in its error.
    for (const marker of markers) {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pack-scan-fixture", version: marker }));
      noMarkers(runMain(root), markers);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

it("scans credential-shaped package metadata without trusting npm's sanitized archive filename", () => {
  const root = fixture();
  const name = "np" + "m_" + randomBytes(24).toString("hex");
  const description = "Bearer " + randomBytes(24).toString("hex");
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0", description, files: PUBLIC_FILES }));
    const result = verifyPackage(root);
    noMarkers(result.failures.join("\n") + JSON.stringify(result) + runMain(root), [name, description]);
    deepEqual(result.failures, ["package.json: npm credential", "package.json: bearer credential"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("thrown errors omit credential-shaped caller paths at every position, including URL escaping", () => {
  const root = fixture();
  try {
    for (const position of ["directory", "basename", "extension"]) {
      const marker = "Bearer " + randomBytes(24).toString("hex");
      const file = position === "directory" ? `${marker}/caller.mts`
        : position === "basename" ? `${marker}.mts` : `caller.${marker}.mts`;
      const caller = join(root, file);
      mkdirSync(dirname(caller), { recursive: true });
      writeFileSync(caller, `import { verifyPackage } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/verify-package.ts")).href)};
try { verifyPackage(${JSON.stringify(join(root, "missing-directory"))}); }
catch (error) { console.log(JSON.stringify({ message: error.message, stack: error.stack, ...error })); }
`);
      const result = spawnSync(process.execPath, [caller], { cwd: ROOT, encoding: "utf8" });
      equal(result.status, 0);
      match(result.stdout, /npm failed during package verification/);
      noMarkers(result.stdout + result.stderr, [marker]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
