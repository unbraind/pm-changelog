/**
 * Test fixture for the `prepare` launcher: puts a stub `pm` first on PATH.
 *
 * Importing the launcher runs the canonical `pm-ops/merge-driver` installer,
 * which resolves `pm` from PATH and runs `pm merge install`. Imported before
 * the launcher, this module makes that resolution find a stub that records its
 * arguments instead of the real CLI, so the test proves the delegation without
 * touching this checkout's clone-local Git configuration.
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Directory holding the stub `pm` executable and its invocation log. */
export const stubDirectory = mkdtempSync(join(tmpdir(), "pm-launcher-stub-"));

/** File the stub appends each invocation's argument list to, one line per call. */
export const stubLog = join(stubDirectory, "invocations.log");

writeFileSync(join(stubDirectory, "pm"), `#!/bin/sh\necho "$@" >> "${stubLog}"\nexit 0\n`, "utf8");
chmodSync(join(stubDirectory, "pm"), 0o755);
process.env.PATH = `${stubDirectory}${delimiter}${process.env.PATH ?? ""}`;
