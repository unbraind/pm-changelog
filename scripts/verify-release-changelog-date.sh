#!/usr/bin/env bash
# Proves an untagged release's changelog heading comes from the calendar
# version rather than from the clock, and that every generator invocation in
# this package asks for that.
#
# Why this exists separately from `npm run changelog:check`: that script only
# exercises the package.json invocation. `.github/workflows/release.yml` calls
# pm-changelog directly. If either side lost --date-from-version the two would
# disagree during a release -- one heading derived from the clock, the other
# from the version -- and the release would fail on the divergence rather than
# on the stale date the flag exists to remove.
set -euo pipefail
cd "$(dirname "$0")/.."
status=0

# 1. Static invariant: every generator invocation, in every tracked file, asks
#    for the version-derived date. Enumerated rather than assumed, because the
#    invocation lives in more places than the scripts named changelog*.
while IFS= read -r file; do
  sites=$(grep -c -- --release-version-from-package "$file")
  flagged=$(grep -c -- --date-from-version "$file" || true)
  if [ "$sites" -gt "$flagged" ]; then
    echo "FAIL: $file has $sites generator invocation(s) but only $flagged carry --date-from-version" >&2
    status=1
  else
    echo "ok - $file: $sites generator invocation(s), all flagged"
  fi
done < <(git ls-files -- package.json '.github/workflows/*.yml' '.github/workflows/*.yaml' \
         | xargs grep -l -- --release-version-from-package 2>/dev/null)
# Scope note: only files that EXECUTE the generator are in scope -- package.json
# scripts and the workflows. Source, docs, dist and test fixtures may mention
# the same flags while describing or exercising them, and holding those to an
# "every mention is flagged" rule would be a false positive (it is, in
# pm-changelog's own repository, which documents both spellings on purpose).

# 1b. Workflow direct invocations: every `node dist/cli.js` continuation block
#     in release.yml must carry --date-from-version. Section 1 above keys on
#     --release-version-from-package, but the "Build and generate changelog"
#     step historically hand-rolled its invocation with --version instead, so
#     section 1 alone would not have caught that omission. This block catches a
#     direct generator invocation reintroduced without the flag regardless of
#     which version flag it uses. It also confirms the step delegates to the
#     package.json scripts (changelog:full / changelog:check) so a future edit
#     cannot silently swap back to a hand-rolled call that drifts on the other
#     flags --respect-item-release and the unbounded output-budget/limit args.
release_yml=".github/workflows/release.yml"
if [ -f "$release_yml" ]; then
  awk '
    /node dist\/cli\.js/ && $0 !~ /^[[:space:]]*#/ { inblock=1; buf=""; hasflag=0 }
    inblock {
      buf = buf $0 ORS
      if (/--date-from-version/) hasflag=1
      if ($0 !~ /\\$/) {
        n++
        if (!hasflag) {
          print "FAIL: release.yml node dist/cli.js block #" n " omits --date-from-version" > "/dev/stderr"
          print buf > "/dev/stderr"
          bad=1
        } else {
          print "ok - release.yml node dist/cli.js block #" n " carries --date-from-version"
        }
        inblock=0
      }
    }
    END { exit (bad ? 1 : 0) }
  ' "$release_yml" || status=1
  # The release workflow must regenerate the changelog through the package.json
  # scripts, not a hand-rolled `node dist/cli.js`, so generate and check cannot
  # drift on --date-from-version, --respect-item-release or the output-budget
  # args. If either script is absent the step was edited back to a hand-rolled
  # call (which the block check above may or may not catch depending on flags).
  for script in changelog:full changelog:check; do
    if ! grep -q -- "npm run $script" "$release_yml"; then
      echo "FAIL: release.yml no longer runs 'npm run $script'; the changelog step may have reverted to a hand-rolled invocation" >&2
      status=1
    else
      echo "ok - release.yml delegates to 'npm run $script'"
    fi
  done
fi
# 2. Behavioural: the flag is what makes the date version-derived. A probe
#    version deliberately unequal to today, so a clock-derived heading and a
#    version-derived heading cannot coincide and the assertion discriminates.
probe=2026.1.2
expected="## ${probe} - 2026-01-02"
today_heading="## ${probe} - $(date -u +%Y-%m-%d)"
# In pm-changelog's own repository the generator is the build output, not a
# dependency, so resolve it in that order rather than assuming node_modules.
if [ -x ./node_modules/.bin/pm-changelog ]; then bin="./node_modules/.bin/pm-changelog"
elif [ -f ./dist/cli.js ]; then bin="node ./dist/cli.js"
else bin="npx pm-changelog"; fi
# The generator refuses a truncated workspace read rather than silently
# omitting entries, so the unbounded controls the real scripts pass are
# required here too.
common=(--pm-root .agents/pm --stdout --pm-bin ./node_modules/.bin/pm
        --pm-arg=--output-budget --pm-arg=unbounded
        --pm-arg=--output-limit --pm-arg=unbounded
        --release-version "$probe")

with=$($bin "${common[@]}" --date-from-version 2>/dev/null | grep -m1 '^## ' || true)
without=$($bin "${common[@]}" 2>/dev/null | grep -m1 '^## ' || true)

if [ "$with" != "$expected" ]; then
  echo "FAIL: with --date-from-version expected '$expected', got '$with'" >&2; status=1
else
  echo "ok - with the flag the heading is version-derived: $with"
fi
if [ "$without" != "$today_heading" ]; then
  echo "note - without the flag the heading was '$without' (expected the clock-derived '$today_heading'); the flag's effect is still asserted above"
else
  echo "ok - without the flag the heading is clock-derived: $without (this is the defect the flag removes)"
fi
exit $status
