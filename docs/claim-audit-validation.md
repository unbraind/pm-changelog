# Public tracker claim-audit validation

Source: public `unbraind/pm-changelog`, main commit
`56f8536702f6d3266825534d502a3dfc947cfb83`.

The validation exported only `.agents/pm` from that commit into a non-Git scratch
project, made every copied tracker file read-only, then read it with the pinned
pm host using unbounded full-list output. Git was absent from `PATH`, ancestor
repository discovery was disabled, and extension loading was disabled for the
read. No source tracker or public item was mutated.

| Measurement | Result |
| --- | ---: |
| Whole-tracker items | 189 |
| Selected generated claims | 165 |
| Exact line mappings verified | 165 |
| Claims with explicit gaps | 165 |
| Claims with no gaps | 0 |
| Missing execution receipts | 165 |
| Missing affirmative delivery | 146 |
| Missing linked tests | 39 |
| Missing resolution prose | 3 |
| Fixed claim lacking recorded repair | 1 |
| Compact JSON bytes | 138556 |
| Compact TOON bytes | 137535 |

No external execution receipts were supplied. Missing receipts are expected gaps,
not evidence that the recorded tests failed. The audit also preserves historical
Fixed wording outside the classifier's closed-issue policy while flagging its
missing repair evidence.

Regenerating with all input rows reversed produced byte-identical JSON. Every
claim text matched its reported Markdown line. The full copied tracker tree's
content digest before and after was identical:
`8f4bf15bf2f14aeeb55d289e4de7ecdf25031502a3d444e2e3c1d166732a6cbc`.

To reproduce against the same public snapshot, export the tracker with
`git archive` into a fresh ordinary directory, make the copy read-only, and call
`readPmItems({ pmRoot, cwd, env, pmArgs: ["--no-extensions"] })` with `PATH` empty
and `GIT_CEILING_DIRECTORIES` set to the scratch project's parent. Pass the result
to `auditChangelogClaims({ items, entryFrom: "close_reason" })`, compare against a
reversed-item invocation, and verify the hash and reported line positions against
`createChangelog` with the same options. Hash every copied tracker file before
and after. Source code and generated report data need not be copied into a Git
repository or published.
