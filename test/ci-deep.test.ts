/** Execute the lifecycle workflow wrapper against failures before and during public-copy validation. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

test('deep lifecycle removes temporary homes and public copies on success and every command failure', () => {
  const document = parseDocument(readFileSync('.github/workflows/ci-deep.yml', 'utf8'), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  const step = workflow.jobs.lifecycle.steps.find((step: { run?: string }) => step.run?.includes('const lifecycleHome'));
  const source = step.run.split("<<'NODE'\n")[1].replace(/\nNODE\s*$/, '');
  const root = mkdtempSync(join(tmpdir(), 'changelog-lifecycle-cleanup-'));
  try {
    const fixture = source.replace('import { execFileSync } from "node:child_process";', `import { mkdirSync } from 'node:fs';
let calls = 0;
const execFileSync = (command, args) => {
  calls++;
  if (calls === Number(process.env.FAIL_AT)) throw new Error('Controlled command failure');
  if (command === 'tar') mkdirSync(join(args.at(-1), '.agents/pm'), { recursive: true });
  return Buffer.alloc(0);
};`).replaceAll('tmpdir()', 'process.env.FIXTURE_TMP_ROOT');
    const script = join(root, 'fixture.mjs');
    writeFileSync(script, fixture + "\nconsole.log('CALL_COUNT=' + calls);\n");
    const run = (failure: number) => spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, FIXTURE_TMP_ROOT: root, FAIL_AT: String(failure) } });
    const success = run(0);
    assert.equal(success.status, 0, success.stderr);
    const count = Number(success.stdout.match(/CALL_COUNT=(\d+)/)?.[1]);
    assert.ok(count > 10);
    assert.deepEqual(readdirSync(root), ['fixture.mjs']);
    for (let failure = 1; failure <= count; failure++) {
      const result = run(failure);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /Controlled command failure/);
      assert.deepEqual(readdirSync(root), ['fixture.mjs'], `failure at command ${failure}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
