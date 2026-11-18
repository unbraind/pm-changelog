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

test("fixed-run summary redacts environment values in TAP and spec titles", () => {
  const output = [
    "not ok 1 - HOME=synthetic-tap",
    `✖ uses mixed_Case="synthetic spec"' suffix' _EMPTY= (12.5ms)`,
    `not ok 3 - preserves "literal=value and x=y" and treats left = right as prose`,
    "not ok 4 - PATH=scratch/test",
  ].join("\n");
  assert.equal(fixedRunFailureSummary(output), [
    "failing tests: HOME=<redacted>",
    "uses mixed_Case=<redacted> _EMPTY=<redacted>",
    `preserves "literal=value and x=y" and treats left = right as prose`,
  ].join("; "));
});

test("fixed-run summary redacts credential-shaped title text", () => {
  const fixtureToken = "glpat-" + "fixture".repeat(3);
  const privateKeyMarker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const output = [
    `not ok 1 - uses ${fixtureToken} with home=synthetic`,
    `✖ encounters ${privateKeyMarker} (1ms)`,
  ].join("\n");
  assert.equal(fixedRunFailureSummary(output), "failing tests: uses <redacted> with home=<redacted>; <redacted>");
});
