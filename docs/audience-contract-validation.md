# Audience contract validation

Validated against public `unbraind/pm-changelog` tracker data at main commit
`78534d1` (2026-10-23). Exported only the tracked project into a scratch directory
without a git repository; made all tracker files read-only and directories
non-writable. The SDK and built standalone command ran with a PATH containing no
git executable and a git ceiling above the tracker.

| Measurement | Result |
| --- | --- |
| Certified full input items | 193 |
| Closed input items | 183 |
| Selected closed changes | 179 |
| Excluded closed non-change dispositions | 4 |
| Release groups | 36 |
| Existing facet declarations | 0 |
| Published notes | 0 |
| Explicit omissions across three audiences | 537 |
| Compact JSON bytes | 35,176 |
| TOON bytes | 19,219 |
| Warm SDK projection elapsed | 611 ms |
| Tracker files verified unchanged | 396 |

This corpus predates facet declarations: zero notes is the expected result, and
537 omissions are three explicit audience gaps for each of 179 selected changes.
No title, closure prose or body was invented as an audience note. Positive mixed
release publication is covered separately by the committed synthetic fixtures:
three selected changes, four notes and five omissions across two release groups.

SDK and standalone JSON matched byte for byte. TOON decoded to the same report.
All three audience projections retained the same ledger fingerprint:
`9ea94c4c8120a9ab8b30f146720020a93b1eb7739b57295b850b710d14c724b4`.

The before/after sorted file-path/content-hash manifest was unchanged, including
file membership. Its SHA-256 was
`4daf656e4b06a5fbee8990c339897bf7beae51697cd53cc6986fc3687a7cb10d`.
The source public tracker was never modified. This is a single warm local
measurement, not a latency guarantee or hosted-backend certification.
