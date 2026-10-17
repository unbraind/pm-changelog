# Dependabot workflow auditor regression

Dependabot #248 updates pm-ops from 2026.10.6 to 2026.10.12. The installed
canonical auditor rejects the inline Bash version regex in `Decide release`:
`cannot prove executable expansion; refusing an unresolved publish path: ?$ ]]`.
Last green main CI run 38903915986 used the older auditor. This is a shell
model compatibility failure, not a dependency-version assertion. Full CI-identity validation also exposes the same missing artifact lifecycle
coverage as pm-ado#30 and pm-beads#144: line 28 in the updated prepare launcher
is unexecuted, leaving that file at 98.65% lines and 75% branches. Use the same
explicit lifecycle helper and real configured-checkout tests in all three
packages. The first full npm/Bun validation runs passed all 613 functional
tests but failed coverage at 99.98% lines and 99.95% branches overall.

Keep the version regex in a single-quoted literal variable and use that
binding in the Bash condition. Parentheses and the optional suffix marker
remain regex data rather than confusing the auditor's command scanner.
The resolved package auditor still checks every publish invocation for
provenance; no gate or publish path is excluded. No dependency pin changes.

The regression test executes the actual workflow condition with Bash and
checks captures for ordinary, suffixed and zero-padded date versions, plus
rejection of malformed versions. The existing repository-workflow gate
checks the complete workflow against whichever pm-ops Dependabot installs.

Revert proof: in the bumped scratch tree, restore only the old workflow
condition and rerun the repository-workflow gate; it must fail with the
unresolved publish path diagnostic. Restore the literal binding and rerun;
it must pass. No rebuild is needed for this source-reading test.

Validation uses `npm run release:check` and `bun run release:check`, each with
an empty HOME, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, on
the fix plus Dependabot's exact dependency and generated-template diff.
The fix branch retains its dependency pins for separate PR CI checks.

Full scratch-tree validation is run on a temporary GitHub validation branch
with the exact dependency and generated-template diff applied to the fix.
This avoids shared-host process timeouts while retaining the complete release
gates and isolated Git identity. The temporary validation workflow uses only
read permissions and runs both release-check commands; it is not part of the
fix PR.

The prepare helper has an independent behavioral revert proof: keep the new
artifact tests and remove only its lifecycle-command injection. The local
launcher coverage gate exits 1 at 98.65% lines / 75% branches, missing line 28.
The current-pin prepare suite passes 10/10 through the PM-linked runner;
the workflow/auditor suite passes 25/25.

## Completed validation

[Full npm and Bun scratch-tree gates](https://github.com/unbraind/pm-changelog/actions/runs/39022870035)
at `43dc3f1d00d13d1acce21d76f3a9b58f7a8b98cc` both passed. Each command
passed 615/615 tests with zero failures, skips, cancellations or todos.
Lines, branches and functions measured 100% across 13 source files.

```sh
env HOME="$(mktemp -d)" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm run release:check
env HOME="$(mktemp -d)" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bun run release:check
```

The validated tree contains the fix plus the original Dependabot dependency
and generated-template changes. The validation workflow is excluded from the
fix branch. Local full runs interrupted by host load are not pass evidence.
