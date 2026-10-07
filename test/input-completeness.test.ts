/** Real tracker receipts must survive the caller-supplied JSON boundary. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { IncompleteListAllError, parsePmItemsJson } from "../src/generator.ts";

test("caller input completeness: real receipts protect full history on stdin and file input", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-input-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pmRoot = join(directory, ".agents", "pm");
  const env = {
    ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(directory, "global-pm"),
    PM_TELEMETRY_DISABLED: "1", PM_AUTHOR: "fixture-agent",
  };
  const pm = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  execFileSync(process.execPath, [pm, "init", "--id-prefix", "fixture", "--no-merge-fence"], { cwd: directory, env });
  for (const [id, title, status] of [
    ["preserved", "Synthetic preserved feature", "closed"],
    ["retained", "Synthetic retained fix", "closed"],
    ["future", "Synthetic future work", "open"],
  ] as const) {
    execFileSync(process.execPath, [pm, "create", "--type", "Feature", "--id", id,
      "--title", title, "--status", status, "--create-mode", "progressive",
      ...(status === "closed" ? ["--close-reason", "Synthetic fixture completion",
        "--completed-at", "2026-10-05T00:00:00Z"] : [])], { cwd: directory, env });
  }
  const complete = await listAllComplete({}, { cwd: directory, pmRoot, noExtensions: true });
  assert.equal(complete.items.length, 3);
  assert.deepEqual(parsePmItemsJson(JSON.stringify(complete)), complete.items);
  const input = join(directory, "input.json");
  const output = join(directory, "CHANGELOG.md");
  const cli = join(process.cwd(), "dist", "cli.js");
  const baseArgs = ["--version", "2026.10.5", "--date", "2026-10-05"];

  for (const transport of ["stdin", "input"]) {
    await t.test(`${transport}: complete delivery allows status and date selection`, () => {
      // Upstream scope selection is independent of retrieval completeness.
      const selected = { ...complete, filters: { status: "closed", since: "2026-10-01" } };
      writeFileSync(input, JSON.stringify(selected));
      const result = spawnSync(process.execPath, [cli, ...baseArgs, "--stdout", "--status", "closed",
        "--since", "2026-10-01", "--until", "2026-10-06",
        ...(transport === "stdin" ? ["--stdin"] : ["--input", input])],
      { input: JSON.stringify(selected), encoding: "utf8", cwd: directory, env });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Synthetic preserved feature/);
      assert.match(result.stdout, /Synthetic retained fix/);
      assert.doesNotMatch(result.stdout, /Synthetic future work/);
    });
  }

  const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ["paginated", { items: complete.items.slice(0, 1), count: 1, has_more: true, next_cursor: "next", truncated: true }, "page_incomplete"],
    ["count mismatch", { total: 4 }, "count_mismatch"],
    ["unreadable", { completeness: { status: "partial", unreadable_item_count: 1, unreadable_directory_count: 0 } }, "source_incomplete"],
    ["contradictory unreadable", { completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 1 } }, "source_incomplete"],
    ["unchecked", { completeness: { status: "unchecked" } }, "source_unchecked"],
    ["row compaction", { read_output: { ...complete.read_output, rows_compacted: true } }, "budget_compaction"],
    ["string compaction", { read_output: { ...complete.read_output, strings_compacted: true } }, "budget_compaction"],
    ["result omitted", { read_output: { ...complete.read_output, result_omitted: true } }, "budget_omission"],
    ["budget truncation", { output_budget_truncation: { reason: "output_budget_reached" } }, "budget_compaction"],
    ["budget omission", { output_budget_exceeded: { omitted_result: true } }, "budget_omission"],
    ["field omission", { omission_receipt: { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: ["body"] } }, "field_omission"],
    ["projection", { projection: { mode: "brief", fields: ["id"] } }, "projection_incomplete"],
    ["session", { read_session: {} }, "session_projection"],
    ["cursor alone", { next_cursor: "next" }, "page_incomplete"],
    ["truncation alone", { truncated: true }, "page_incomplete"],
    ["malformed receipt", { read_output: null }, "read_output_missing"],
  ];
  for (const [name, override, signal] of cases) {
    const raw = JSON.stringify({ ...complete, ...override });
    await t.test(`${name}: SDK inspection refuses before generation`, () => {
      assert.throws(() => parsePmItemsJson(raw),
        (error: unknown) => error instanceof IncompleteListAllError && error.message.includes(signal));
    });
    for (const transport of ["stdin", "input"]) {
      await t.test(`${transport}: ${name} cannot replace full history`, () => {
        const fullHistory = "# Changelog\n\nFull retained history\n";
        writeFileSync(output, fullHistory);
        writeFileSync(input, raw);
        const result = spawnSync(process.execPath, [cli, ...baseArgs, "--output", output,
          ...(transport === "stdin" ? ["--stdin"] : ["--input", input])],
        { input: raw, encoding: "utf8", cwd: directory, env });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /incomplete and was refused/);
        assert.ok(result.stderr.includes(signal), result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(readFileSync(output, "utf8"), fullHistory);
      });
    }
  }

  await t.test("bare arrays and legacy receipt-free documents retain intentional subset semantics", () => {
    const subset = complete.items.slice(0, 1);
    for (const document of [subset, { items: subset }, { items: subset, filters: { status: "closed" } },
      { items: subset, count: 1, total: 1, truncated: false, has_more: false,
        completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 } }]) {
      const raw = JSON.stringify(document);
      assert.deepEqual(parsePmItemsJson(raw), subset);
      for (const transport of ["stdin", "input"]) {
        writeFileSync(input, raw);
        const result = spawnSync(process.execPath, [cli, ...baseArgs, "--stdout", "--status", "open,closed",
          ...(transport === "stdin" ? ["--stdin"] : ["--input", input])],
        { input: raw, encoding: "utf8", cwd: directory, env });
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(subset[0]!.title));
      }
    }
  });
});
