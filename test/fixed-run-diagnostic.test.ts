import assert from "node:assert/strict";
import test from "node:test";

import { fixedRunFailureSummary } from "../scripts/fixed-run-diagnostic.ts";

test("fixed-run summary names TAP and spec failures without paths or environment", () => {
  const output = [
    "not ok 1 - ten releases retain every transition",
    "not ok 2 - scratch/test/agent-contract-drift.test.ts",
    "✖ comparison refuses dimensions (12.5ms)",
    "✖ scratch/test/core.test.ts",
    "HOME=secret PATH=secret DO_NOT_TRACK=1",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'scratch/test/support/depth.ts'",
  ].join("\n");
  const summary = fixedRunFailureSummary(output);
  assert.equal(summary, "failing tests: ten releases retain every transition; comparison refuses dimensions");
  assert.doesNotMatch(summary, /scratch|secret|HOME|PATH|DO_NOT_TRACK/);
});

test("fixed-run summary uses the error code when a file fails to load", () => {
  const output = [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'scratch/test/support/depth.ts'",
    "not ok 1 - scratch/test/agent-contract-drift.test.ts",
    "  error: 'test failed'",
    "  code: 'ERR_TEST_FAILURE'",
    "PATH=secret",
  ].join("\n");
  const summary = fixedRunFailureSummary(output);
  assert.equal(summary, "failing tests: ERR_MODULE_NOT_FOUND");
  assert.doesNotMatch(summary, /scratch|secret|PATH|ERR_TEST_FAILURE/);
});
