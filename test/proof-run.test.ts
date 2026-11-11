import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ProofRun } from "../scripts/proof-run.ts";
import { emptyUnreleasedMutation } from "../scripts/empty-unreleased-proof.ts";

test("proof reports every mutation and restored control after an early missing seam", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pm-proof-cases-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "generator.ts");
  const source = readFileSync(resolve("src/generator.ts"), "utf8");
  writeFileSync(file, source);
  const proof = new ProofRun();
  proof.run("missing-seam", () => emptyUnreleasedMutation("missing", "revert-prepend-cleanup"));
  proof.run("later-mutation", () => {
    const mutation = emptyUnreleasedMutation(source, "revert-prepend-cleanup");
    assert.ok(mutation.from.includes("RENDERING_PROFILES"));
    try {
      writeFileSync(file, source.replace(mutation.from, mutation.to));
      assert.notEqual(readFileSync(file, "utf8"), source);
    } finally { writeFileSync(file, source); }
  });
  proof.run("restored-controls", () => assert.equal(readFileSync(file, "utf8"), source));
  assert.deepEqual(proof.results.map(({ name, passed }) => [name, passed]), [["missing-seam", false], ["later-mutation", true], ["restored-controls", true]]);
  assert.throws(() => proof.finish(), /Missing or ambiguous generator seam/);
  for (const name of ["restore-empty-Unreleased-visibility", "revert-prepend-cleanup", "drop-nonempty-Unreleased", "drop-dependency-only-sections"]) {
    const mutation = emptyUnreleasedMutation(source, name);
    assert.ok(source.includes(mutation.from));
    assert.notEqual(source.replace(mutation.from, mutation.to), source);
    assert.throws(() => emptyUnreleasedMutation("", name), /Missing or ambiguous/);
  }
  assert.throws(() => emptyUnreleasedMutation(source, "constructor"), /Unknown proof mutation/);
});
