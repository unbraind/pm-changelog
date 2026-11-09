/** Contract diagnostics describe published assertions, not hidden source metadata. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decode } from "@toon-format/toon";
import { readSettings, resolveRuntimeStatusRegistry, runInit, schemaAddStatus } from "@unbrained/pm-cli/sdk";
import { auditChangelogClaims, buildChangelogDocument, createChangelog, formatClaimAudit } from "../src/index.ts";
import type { GenerateChangelogOptions, PmItem } from "../src/index.ts";

test("contract audit: only published assertions produce contract gaps across every context", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-contract-audit-policy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".agents/pm");
  await runInit("audit", { path: root }, { defaults: true, agentGuidance: "skip" });
  await schemaAddStatus("delivered", { role: ["terminal", "terminal_done"], alias: ["constructor"] }, { pmRoot: root });
  await schemaAddStatus("closed_active", { role: ["active"] }, { pmRoot: root });
  const registry = resolveRuntimeStatusRegistry((await readSettings(root)).schema);
  const id = "fixture-audit-policy";
  const contexts: Array<{ status: string; options: Omit<GenerateChangelogOptions, "items"> }> = [
    { status: "closed", options: {} },
    { status: "constructor", options: { statusRegistry: registry } },
    { status: "closed_active", options: { statusRegistry: registry, includeStatuses: ["closed_active"] } },
    { status: "closed_active", options: { statusRegistry: registry, statusSelection: new Map([[id, true]]) } },
    { status: "closed", options: { statusSelection: new Map([[id, false]]) } },
    { status: "open", options: {} },
  ];
  const declarations = [undefined, null, false, 3, {}, { before: "Allowed", after: "Refused" },
    { before: "", after: "", migrate: "Handle refusal" }, { before: "Allowed", after: "Refused", migrate: "Handle refusal" }];
  let hidden = 0, published = 0, excluded = 0;
  for (const type of ["Issue", "Bug", "Defect", "Bugfix", "Task"]) {
    for (const context of contexts) for (const repaired of [false, true]) for (const declaration of declarations) {
      for (const placement of ["direct", "metadata", "null-fallback"]) {
        const item: PmItem = { id, title: "SDK contract words and Migrate: do not declare behavior", type, status: context.status,
          close_reason: "Investigation complete", breaking: true, assignee: "fixture", tags: ["Closed", "Changed (SDK contract)"],
          ...(repaired ? { files: [{ path: "src/parser.ts" }] } : {}),
          ...(placement === "direct" ? { contract_change: declaration } : { ...(placement === "null-fallback" ? { contract_change: null } : {}), metadata: { contract_change: declaration } }) };
        for (const sectionBy of ["category", "type", "status", "label"] as const) {
          const options = { ...context.options, items: [item], date: "2026-11-06", sectionBy, contributors: true,
            breakingChanges: true, conventional: true, entryFrom: "close_reason" as const };
          const original = JSON.stringify(item);
          const kinds: string[] = [];
          const markdown = createChangelog(options, (source) => kinds.push(source.kind)).markdown;
          const document = buildChangelogDocument(options);
          const projection = document.releases.flatMap((release) => release.sections.flatMap((section) => section.items)).find((row) => row.id === id);
          const contract = projection?.contract_change;
          const report = auditChangelogClaims(options);
          assert.equal(report.claim_count, kinds.length);
          for (const [index, claim] of report.claims.entries()) {
            assert.equal(claim.claim, markdown.split("\n")[claim.line - 1]);
            if (kinds[index] === "item") {
              for (const gap of ["delivery", "tests", "test_result"] as const) assert.ok(claim.gaps.includes(gap));
            } else assert.deepEqual(claim.gaps, []);
            assert.equal(claim.gaps.includes("migration"), kinds[index] === "item" && contract !== undefined && !contract.migrate);
            assert.equal(claim.gaps.includes("contract_change"), kinds[index] === "item" && contract !== undefined && (!contract.before || !contract.after));
          }
          if (contract === undefined) {
            // Hidden declarations cannot affect ordinary evidence gaps, remedies or readiness.
            const plain = { ...item, contract_change: undefined, metadata: undefined };
            assert.deepEqual(report, auditChangelogClaims({ ...options, items: [plain] }));
            if (projection) hidden++; else excluded++;
          } else published++;
          if (sectionBy === "category") {
            const json = JSON.parse(formatClaimAudit(report, "json"));
            const toon = decode(formatClaimAudit(report, "toon")) as { claims?: { gaps: string }[] };
            assert.deepEqual((toon.claims ?? []).map((row) => JSON.parse(row.gaps)), json.claims.map((row: { gaps: string[] }) => row.gaps));
          }
          assert.equal(JSON.stringify(item), original);
        }
      }
    }
  }
  assert.ok(hidden > 0 && published > 0 && excluded > 0);
  t.diagnostic(`publication oracle: hidden=${hidden}, published=${published}, excluded=${excluded}; aliases, frozen roles, repair evidence, all groupings and JSON/TOON`);
});
