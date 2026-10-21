# Claim evidence audit example

Before publication, retain a passing execution receipt for a linked command:

```json
[
  {
    "item": "demo-parser",
    "command": "node --test test/parser.test.ts",
    "outcome": "passed",
    "reference": "https://example.com/ci/runs/42"
  }
]
```

```ts
import {
  auditChangelogClaims,
  assertChangelogClaims,
  formatClaimAudit,
  ClaimAuditError,
} from "pm-changelog";

const report = auditChangelogClaims({
  entryFrom: "close_reason",
  items: [{
    id: "demo-parser",
    title: "Parser fails on empty input",
    type: "Issue",
    status: "closed",
    close_reason: "Fixed empty-input parsing; merged PR #42",
    files: [{ path: "src/parser.ts" }],
    tests: [{ command: "node --test test/parser.test.ts" }],
  }],
}, [{
  item: "demo-parser",
  command: "node --test test/parser.test.ts",
  outcome: "passed",
  reference: "https://example.com/ci/runs/42",
}]);

console.log(formatClaimAudit(report, "json"));
try {
  assertChangelogClaims(report);
} catch (error) {
  if (error instanceof ClaimAuditError) {
    console.error(error.code, error.remedy, error.report?.unsupported_count);
  }
  throw error;
}
```

This produces one supported `Fixed` claim. Omitting the receipt yields a
`test_result` gap. Replacing the resolution with `Closed on GitHub as completed`
and removing files/tests produces neutral `Closed` wording with explicit gaps.
A declaration never becomes an execution result merely because the item is closed.

Reuse the same generation options for audit and publication. The report hash
identifies the generated Markdown bytes; verify it against the artifact you will
publish. Regeneration preserves line order and evidence order, and inserts no
clock-dependent audit timestamp. Failed receipts for a command dominate passing
receipts for that command; remove an obsolete receipt only after resolving and
retaining the relevant evidence elsewhere.
