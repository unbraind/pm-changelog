import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { listAllComplete } from "@unbrained/pm-cli/sdk";

test("registered proof commands give the native runner their declared timeout budget", async () => {
  const item = (await listAllComplete({}, { pmRoot: resolve(".agents/pm") })).items.find((item) => item.id === "pmc-check-generator-drift");
  assert.ok(item);
  const proof = item.tests?.find((test) => test.command === "timeout 1200 node scripts/prove-empty-unreleased-revert.ts");
  assert.ok(proof);
  assert.equal(proof.timeout_seconds, 1200);
  for (const entry of item.tests ?? []) {
    const seconds = /^timeout (?:--kill-after=\S+ )?(\d+) /.exec(entry.command ?? "")?.[1];
    if (seconds) assert.equal(entry.timeout_seconds, Number(seconds), entry.command ?? "Registered proof");
  }
});
