import assert from "node:assert/strict";
import test from "node:test";
import { testDepth } from "./support/depth.ts";

test("depth defaults to full and quick keeps a deterministic prefix with a floor of 25", () => {
  const original = process.env.PM_TEST_DEPTH;
  try {
  for (const depth of [undefined, "full", "unknown", "quick"]) {
    if (depth === undefined) delete process.env.PM_TEST_DEPTH;
    else process.env.PM_TEST_DEPTH = depth;
    assert.equal(testDepth(500), depth === "quick" ? 50 : 500);
    assert.equal(testDepth(128), depth === "quick" ? 25 : 128);
    assert.equal(testDepth(10), 10);
  }
  } finally {
    if (original === undefined) delete process.env.PM_TEST_DEPTH;
    else process.env.PM_TEST_DEPTH = original;
  }
});
