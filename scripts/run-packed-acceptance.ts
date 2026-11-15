/** Bound the complete packed installation matrix and terminate all inherited descendants on expiry. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runCommand, scaledBudget, ACCEPTANCE_TOTAL_BUDGET_MS } from "./acceptance-process.ts";

const result = await runCommand(process.execPath, ["scripts/accept-release-corrections.ts"], {
  cwd: resolve(import.meta.dirname, ".."),
  timeoutMs: scaledBudget(ACCEPTANCE_TOTAL_BUDGET_MS),
});
assert.equal(result.status, 0, result.stderr);
process.stdout.write(result.stdout);
