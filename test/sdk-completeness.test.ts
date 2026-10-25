/** Exercise complete-list certification and fresh history verification on a real non-git tracker. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { listAllComplete, listMutationEvents, readHistoryEntries, verifyHistoryEntries } from "@unbrained/pm-cli/sdk";
import { IncompleteListAllError, parseListAllItemsJson, parsePmItemsJson, readPmItems } from "../src/generator.ts";

test("SDK whole-corpus certification rejects contradictory receipts before changelog writes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-sdk-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pmRoot = join(directory, ".agents", "pm");
  const pm = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const env = { ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(directory, "global-pm"),
    DO_NOT_TRACK: "1", PM_AUTHOR: "fixture-agent", GIT_CEILING_DIRECTORIES: dirname(directory) };
  execFileSync(process.execPath, [pm, "init", "--id-prefix", "fixture", "--no-merge-fence"], { cwd: directory, env });
  execFileSync(process.execPath, [pm, "create", "--id", "retained", "--type", "Feature",
    "--title", "Synthetic retained change", "--create-mode", "progressive"], { cwd: directory, env });
  const complete = await listAllComplete({}, { cwd: directory, pmRoot, noExtensions: true });
  const raw = JSON.stringify(complete);
  assert.deepEqual(parseListAllItemsJson(raw), complete.items);
  assert.deepEqual(readPmItems({ cwd: directory, pmRoot, env: { ...env, PATH: "" } }), complete.items);
  assert.deepEqual(parseListAllItemsJson(JSON.stringify({ ...complete, read_output: undefined })), complete.items);

  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["source contradiction", { completeness: { status: "complete", unreadable_item_count: 1, unreadable_directory_count: 0 } }, "source_incomplete"],
    ["missing unreadable counts", { completeness: { status: "complete" } }, "source_unchecked"],
    ["filtered corpus", { filters: { ...complete.filters, status: "open" } }, "filtered_corpus"],
    ["runtime filter", { filters: { ...complete.filters, runtime_filters: { team: "synthetic" } } }, "filtered_corpus"],
    ["terminal exclusion", { filters: { ...complete.filters, exclude_terminal: true } }, "terminal_items_excluded"],
    ["non-strict source", { filters: { ...complete.filters, strict_read: false } }, "strict_read_unproven"],
    ["bounded read", { applied_limit: 1 }, "page_incomplete"],
    ["brief projection", { projection: { mode: "brief", fields: ["id"] } }, "projection_incomplete"],
    ["missing omission receipt", { omission_receipt: undefined }, "omission_receipt_missing"],
    ["contradictory omission receipt", { omission_receipt: { has_omissions: false, omitted_field_group_count: 1, omitted_field_groups: ["body"] } }, "omission_receipt_invalid"],
    ["malformed read receipt", { read_output: null }, "read_output_missing"],
    ["row compaction", { read_output: { ...complete.read_output, rows_compacted: true } }, "budget_compaction"],
    ["omitted result", { output_budget_exceeded: { omitted_result: true } }, "budget_omission"],
    ["session suppression", { read_session: {} }, "session_projection"],
    ["invalid item ID", { items: [{ ...complete.items[0], id: "" }] }, "invalid_item_id"],
    ["duplicate item IDs", { items: [complete.items[0], complete.items[0]], count: 2, total: 2 }, "duplicate_item_id"],
  ];
  const input = join(directory, "input.json");
  const output = join(directory, "CHANGELOG.md");
  const cli = join(process.cwd(), "dist", "cli.js");
  for (const [name, override, signal] of cases) {
    await t.test(name, () => {
      const candidate = JSON.stringify({ ...complete, ...override });
      assert.throws(() => parseListAllItemsJson(candidate), (error: unknown) =>
        error instanceof IncompleteListAllError && error.signals.some((finding) => finding.startsWith(`${signal}:`)));
      // Caller scope remains intentional, while every delivery contradiction
      // must still refuse before the persisted changelog can be replaced.
      if (signal === "filtered_corpus" || signal === "terminal_items_excluded" || signal === "strict_read_unproven") {
        assert.deepEqual(parsePmItemsJson(candidate), complete.items);
      } else {
        writeFileSync(input, candidate);
        writeFileSync(output, "# Retained release history\n");
        const result = spawnSync(process.execPath, [cli, "--input", input, "--output", output],
          { cwd: directory, env, encoding: "utf8" });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /incomplete and was refused/);
        assert.equal(readFileSync(output, "utf8"), "# Retained release history\n");
      }
    });
  }

  await t.test("fresh history verification detects corruption after SDK list cache priming", async () => {
    const history = join(pmRoot, "history", "fixture-retained.jsonl");
    const before = await readHistoryEntries(history, "fixture-retained");
    assert.equal(verifyHistoryEntries(before).ok, true);
    await listAllComplete({}, { cwd: directory, pmRoot, noExtensions: true });
    const cached = await listMutationEvents({ cwd: directory, pmRoot, item: "fixture-retained", full: true });
    assert.equal(cached.source, "derived_index");
    assert.equal(cached.count, before.length);
    const entries = readFileSync(history, "utf8").trimEnd().split("\n");
    const first = JSON.parse(entries[0]!) as Record<string, unknown>;
    first.after_hash = "0".repeat(64);
    entries[0] = JSON.stringify(first);
    writeFileSync(history, `${entries.join("\n")}\n`);
    const verification = verifyHistoryEntries(await readHistoryEntries(history, "fixture-retained"));
    assert.equal(verification.ok, false);
    assert.ok(verification.errors.length > 0);
  });
});
