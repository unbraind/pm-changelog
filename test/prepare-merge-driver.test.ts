/** Tests the thin `prepare` launcher over the canonical `pm-ops/merge-driver`. */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Import order is load-bearing: the stub `pm` must be first on PATH before the
// launcher module runs the canonical installer, so this checkout's Git config
// is never touched by the test.
import { stubLog } from "./stub-pm-on-path.ts";
import "../scripts/prepare-merge-driver.ts";

test("importing the launcher runs the canonical installer, which invokes `pm merge install`", () => {
  assert.strictEqual(process.exitCode, 0);
  assert.strictEqual(readFileSync(stubLog, "utf8").trim(), "merge install");
});

test("a failing `pm merge install` makes the launcher exit non-zero instead of passing silently", (t) => {
  const failing = mkdtempSync(join(tmpdir(), "pm-launcher-fail-"));
  t.after(() => rmSync(failing, { recursive: true, force: true }));
  writeFileSync(join(failing, "pm"), "#!/bin/sh\nexit 3\n", "utf8");
  chmodSync(join(failing, "pm"), 0o755);
  const launcher = fileURLToPath(new URL("../scripts/prepare-merge-driver.ts", import.meta.url));
  const run = spawnSync(process.execPath, [launcher], {
    env: { ...process.env, PATH: `${failing}${delimiter}${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  assert.notStrictEqual(run.status, 0, "a present pm that fails to install the drivers must fail the prepare hook");
});
