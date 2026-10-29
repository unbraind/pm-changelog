/** Measure real public metadata without writing to the read-only non-git source copy. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { decode } from "@toon-format/toon";
import { createChangelog, formatAgentContractDrift, readAgentContractDrift } from "../src/index.ts";

/** Hash every regular source file to prove content and membership stayed unchanged. */
function manifest(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => { const path = join(entry.parentPath, entry.name); return `${path.slice(root.length + 1)} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`; }).sort();
}
const root = resolve(process.argv[2]), before = manifest(root);
const items = (await listAllComplete({ includeBody: false }, { pmRoot: root })).items;
const started = performance.now();
const report = await readAgentContractDrift(root, { from: "0.0.0", to: "2026.10.28" });
const elapsed = performance.now() - started;
const json = formatAgentContractDrift(report, "json"), toon = formatAgentContractDrift(report, "toon");
assert.deepEqual(decode(toon), report);
const cli = spawnSync(process.execPath, [resolve("dist/cli.js"), "drift", "--pm-root", root, "--from", "0.0.0", "--to", "2026.10.28", "--json"], { encoding: "utf8", env: { PATH: "", DO_NOT_TRACK: "1" } });
assert.equal(cli.status, 0, cli.stderr); assert.equal(cli.stdout, json);
assert.deepEqual(manifest(root), before);
console.log(JSON.stringify({ input_items: items.length,
  declared_facets: items.reduce((count, item) => count + (Array.isArray(item.change_facets) ? item.change_facets.filter((facet) => facet.audience === "agent-behavior").length : 0), 0),
  definitions: report.definitions.length, changes: report.changes.length, unchanged_references: report.unchanged.length,
  omissions: report.omissions.length, complete: report.complete, json_bytes: Buffer.byteLength(json), toon_bytes: Buffer.byteLength(toon),
  all_notes_bytes: Buffer.byteLength(createChangelog({ items, groupBy: "release", entryFrom: "close_reason" }).markdown),
  warm_sdk_ms: Math.round(elapsed), unchanged_files: before.length, manifest_sha256: createHash("sha256").update(before.join("\n")).digest("hex"), sdk_cli_equal: true, git_required: false }, null, 2));
