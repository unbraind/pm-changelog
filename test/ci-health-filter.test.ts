/** The tracker-health filter each CI tier applies to `pm health --json`, run through the real jq program. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const PROVENANCE = 'provenance_value_domain_invalid:claude-code:role:single_digit:32';

/** Extract the jq program that follows `printf '%s\n' "$health_json" | jq -e '` in a workflow file. */
function healthFilter(workflow: string): string {
  const source = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), 'utf8');
  const match = /\$health_json" \| jq -e '\n([\s\S]*?)\n\s*'\n/u.exec(source);
  assert.ok(match, `${workflow} must pipe the health report through one jq -e filter`);
  return match[1];
}

/** Run the workflow's own filter on a health report and say whether the gate accepts it. */
function accepts(filter: string, warnings: string[]): boolean {
  const result = spawnSync('jq', ['-e', filter], { input: JSON.stringify({ warnings }), encoding: 'utf8' });
  assert.ok(result.error === undefined, `jq must be available: ${String(result.error)}`);
  assert.ok([0, 1].includes(result.status ?? -1), `jq failed to evaluate the filter: ${result.stderr}`);
  return result.status === 0;
}

for (const workflow of ['ci.yml', 'ci-deep.yml']) {
  test(`${workflow} health filter accepts only the declared advisories`, () => {
    const filter = healthFilter(workflow);

    for (const warnings of [
      [PROVENANCE],
      [PROVENANCE, 'in_progress_unowned:1', 'in_progress_idle:12'],
      [PROVENANCE, 'stale_in_progress_items:2', 'telemetry_flush_pending:3'],
      [PROVENANCE, 'history_stream_over_compact_threshold:pmc-x:900', 'provenance_resolver_zero_success:3'],
    ]) assert.equal(accepts(filter, warnings), true, JSON.stringify(warnings));

    for (const [reason, warnings] of [
      ['a zero count', [PROVENANCE, 'in_progress_idle:0']],
      ['a non-numeric count', [PROVENANCE, 'in_progress_unowned:many']],
      ['a count with a suffix', [PROVENANCE, 'in_progress_idle:3:extra']],
      ['a look-alike prefix', [PROVENANCE, 'in_progress_blocked:1']],
      ['an unknown warning', [PROVENANCE, 'history_drift:pmc-x']],
      ['a changed frozen provenance value', ['provenance_value_domain_invalid:claude-code:role:single_digit:33']],
      ['a second provenance warning', [PROVENANCE, 'provenance_value_domain_invalid:codex:role:single_digit:1']],
      ['a missing frozen provenance warning', ['in_progress_idle:1']],
    ] as const) assert.equal(accepts(filter, [...warnings]), false, reason);
  });
}

test('both CI tiers apply the same health filter', () => {
  const normalise = (text: string) => text.split('\n').map(line => line.trim()).join('\n');
  assert.equal(normalise(healthFilter('ci.yml')), normalise(healthFilter('ci-deep.yml')));
});
