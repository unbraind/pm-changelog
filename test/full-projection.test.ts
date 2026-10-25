/** Whole-tracker reads keep every projected field and reject real omission receipts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listAllComplete } from "@unbrained/pm-cli/sdk";
import {
  buildPmListArgs,
  IncompleteListAllError,
  parseListAllItemsJson,
  readPmItems,
} from "../src/generator.ts";

test("whole-tracker full projection retains every field and keeps schema flags local", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pm-changelog-projection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pmRoot = join(directory, ".agents", "pm");
  const pm = join(process.cwd(), "node_modules", "@unbrained", "pm-cli", "dist", "cli.js");
  const env = {
    ...process.env, PM_PATH: pmRoot, PM_GLOBAL_PATH: join(directory, "global-pm"),
    DO_NOT_TRACK: "1", PM_AUTHOR: "fixture-agent",
  };
  const options = { pmRoot, pmBin: join(process.cwd(), "node_modules", ".bin", "pm"), cwd: directory, env };
  execFileSync(process.execPath, [pm, "init", "--id-prefix", "fixture", "--no-merge-fence"], { cwd: directory, env });
  execFileSync(process.execPath, [pm, "schema", "add-type", "Story", "--folder", "custom-stories"], { cwd: directory, env });
  for (const [id, type, status] of [["pending", "Task", "open"], ["delivered", "Story", "closed"]] as const) {
    execFileSync(process.execPath, [pm, "create", "--id", id, "--type", type,
      "--title", `Synthetic ${id} change`, "--description", `Synthetic ${id} description`,
      "--priority", "1", "--status", status, "--create-mode", "progressive",
      ...(status === "closed" ? ["--close-reason", "Synthetic completion", "--completed-at", "2026-10-18T00:00:00Z"] : [])],
    { cwd: directory, env });
  }
  const certified = await listAllComplete({}, { cwd: directory, pmRoot, noExtensions: true });
  assert.equal(certified.items.length, 2);
  const rows = readPmItems(options);
  for (const expected of certified.items) {
    const actual = rows.find((row) => row.id === expected.id);
    assert.ok(actual, `whole-tracker read must retain ${expected.id}`);
    // Compare every field delivered by the independent certified SDK read.
    assert.deepEqual(actual, { ...expected, itemFolder: expected.type === "Story" ? "custom-stories" : "tasks" });
    assert.ok(Object.keys(expected).length > 4);
    assert.ok(actual.description);
    assert.ok(actual.created_at);
    assert.ok(actual.updated_at);
    assert.equal(actual.priority, 1);
  }
  const delivered = rows.find((row) => row.status === "closed");
  assert.equal(delivered?.completed_at, "2026-10-18T00:00:00.000Z");
  assert.equal(delivered?.close_reason, "Synthetic completion");

  // Remove only the projection flag from the same real command: every row is
  // still present, but the host reports omitted fields and parsing must refuse.
  const brief = execFileSync(options.pmBin, buildPmListArgs(options).filter((arg) => arg !== "--full"),
    { cwd: directory, env, encoding: "utf8" });
  const envelope = JSON.parse(brief) as { items: unknown[]; omission_receipt: { has_omissions: boolean } };
  assert.equal(envelope.items.length, 2);
  assert.equal(envelope.omission_receipt.has_omissions, true);
  assert.throws(() => parseListAllItemsJson(brief),
    (error: unknown) => error instanceof IncompleteListAllError && error.message.includes("field_omission"));
});
