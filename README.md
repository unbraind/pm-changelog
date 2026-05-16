# pm-changelog

Generate `CHANGELOG.md` from pm-cli items for local releases, GitHub Actions, runners, and scripts.

The package provides:

- `pm-changelog`, a standalone CLI that reads `pm list-all --json` or JSON input
- `generateChangelog()`, a programmatic TypeScript/JavaScript API
- `pm changelog generate`, a pm-cli extension command

## Install

```bash
npm install
npm run build
```

To use it as a pm-cli extension:

```jsonc
{
  "extensions": [
    { "path": "/path/to/pm-changelog" }
  ]
}
```

## CLI

Generate `CHANGELOG.md` from the current pm project:

```bash
pm-changelog
```

Generate release notes for a CI release:

```bash
pm-changelog --pm-root . --version "$GITHUB_REF_NAME" --since 2026-05-01
```

Print markdown instead of writing a file:

```bash
pm-changelog --stdout --version 1.2.0
```

Read JSON from a previous step:

```bash
pm list-all --json | pm-changelog --stdin --stdout
```

Useful options:

| Option | Default | Description |
|---|---:|---|
| `--output <file>` | `CHANGELOG.md` | Output path |
| `--stdout` | false | Print markdown instead of writing a file |
| `--input <file>` | - | Read pm JSON from a file |
| `--stdin` | false | Read pm JSON from stdin |
| `--pm-root <dir>` | - | Run `pm --path <dir> list-all --json` |
| `--version <version>` | `Unreleased` | Version heading |
| `--date <date>` | today | Release date |
| `--since <date>` | - | Include items changed on or after date |
| `--until <date>` | - | Include items changed on or before date |
| `--status <list>` | `closed` | Comma-separated statuses |
| `--group-by <mode>` | `version` | `version` or `milestone` |
| `--include-empty` | false | Emit an empty section when no items match |

## pm-cli command

```bash
pm changelog generate
pm changelog generate --version 1.2.0 --output CHANGELOG.md
pm changelog generate --stdout --group-by milestone
```

## Programmatic API

```ts
import { generateChangelog, readPmItems } from "pm-changelog";

const items = readPmItems({ pmRoot: process.cwd() });
const markdown = generateChangelog({
  items,
  version: process.env.GITHUB_REF_NAME,
  since: process.env.CHANGELOG_SINCE,
});

console.log(markdown);
```

You can also pass items directly:

```ts
import { generateChangelog } from "pm-changelog";

const markdown = generateChangelog({
  version: "1.2.0",
  items: [
    {
      id: "pm-123",
      title: "Fix CSV import status handling",
      status: "closed",
      type: "Bug",
      tags: ["fix"],
      updated_at: "2026-05-17T09:00:00Z",
    },
  ],
});
```

## Categorization

Items are grouped into Keep a Changelog-style sections using `type`, `tags`, and title keywords:

- `Added`: feature, feat, added, add, new
- `Changed`: change, refactor, update, improve
- `Fixed`: fix, bug, hotfix, regression
- `Removed`: removed, delete
- `Security`: security, CVE, vulnerability
- `Deprecated`: deprecated, deprecation
- `Other`: anything else

## GitHub Actions Example

```yaml
name: Changelog

on:
  workflow_dispatch:
  release:
    types: [published]

jobs:
  changelog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - run: node dist/cli.js --version "${GITHUB_REF_NAME}" --output CHANGELOG.md
```

## Build

```bash
npm run build
```

TypeScript 5, ES2022 target, NodeNext module resolution.

## License

MIT
