import assert from "node:assert/strict";
import test from "node:test";

import { buildChangelogDocument, createChangelog } from "../dist/index.js";
import type { PmItem } from "../dist/index.js";

const items: PmItem[] = [
  {
    id: "pm-feat",
    title: "Add dark mode toggle",
    status: "closed",
    type: "Feature",
    tags: ["feature"],
    assignee: "alice",
    release: "1.2.0",
    updated_at: "2026-05-28T09:00:00Z",
  },
  {
    id: "pm-bug",
    title: "Crash on empty input",
    status: "closed",
    type: "Issue",
    tags: ["bug"],
    assignee: "bob",
    release: "1.2.0",
    updated_at: "2026-05-28T08:00:00Z",
  },
  {
    id: "pm-docs",
    title: "Improve the readme",
    status: "closed",
    type: "Task",
    tags: ["docs"],
    assignee: "alice",
    author: "carol",
    release: "1.2.0",
    updated_at: "2026-05-28T07:00:00Z",
  },
];

// ---------------------------------------------------------------------------
// Zero-regression guard: absent flags reproduce the default output exactly.
// ---------------------------------------------------------------------------
test("default output is unchanged when no opt-in flags are passed", () => {
  const base = createChangelog({ items, version: "1.2.0", date: "2026-05-28" }).markdown;
  // All new options at their default/false values must yield the same bytes.
  const explicitDefaults = createChangelog({
    items,
    version: "1.2.0",
    date: "2026-05-28",
    sectionBy: "category",
    conventional: false,
    contributors: false,
    limit: undefined,
    sinceVersion: undefined,
  }).markdown;
  assert.equal(explicitDefaults, base);
  // Sanity: the default uses keep-a-changelog headings.
  assert.match(base, /### Added\n/);
  assert.match(base, /### Fixed\n/);
});

// ---------------------------------------------------------------------------
// --conventional
// ---------------------------------------------------------------------------
test("--conventional remaps headings but not item bucketing/order", () => {
  const def = createChangelog({ items, version: "1.2.0", date: "2026-05-28" }).markdown;
  const conv = createChangelog({ items, version: "1.2.0", date: "2026-05-28", conventional: true }).markdown;
  assert.notEqual(conv, def);
  assert.match(conv, /### Features\n\n- Add dark mode toggle/);
  assert.match(conv, /### Bug Fixes\n\n- Crash on empty input/);
  assert.doesNotMatch(conv, /### Added\n/);
  // Item lines themselves are byte-identical to the default (only headings change).
  const defItems = def.split("\n").filter((l) => l.startsWith("- "));
  const convItems = conv.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(convItems, defItems);
});

// ---------------------------------------------------------------------------
// --section-by
// ---------------------------------------------------------------------------
test("--section-by type groups by item type", () => {
  const md = createChangelog({ items, version: "1.2.0", date: "2026-05-28", sectionBy: "type" }).markdown;
  assert.match(md, /### Feature\n\n- Add dark mode toggle/);
  assert.match(md, /### Issue\n\n- Crash on empty input/);
  assert.match(md, /### Task\n\n- Improve the readme/);
});

test("--section-by status groups by item status", () => {
  const md = createChangelog({ items, version: "1.2.0", date: "2026-05-28", sectionBy: "status" }).markdown;
  assert.match(md, /### Closed\n/);
});

test("--section-by label groups by tag; missing tags fall into Unlabeled", () => {
  const withUntagged: PmItem[] = [
    ...items,
    { id: "pm-none", title: "Untagged work", status: "closed", type: "Task", release: "1.2.0", updated_at: "2026-05-28T06:00:00Z" },
  ];
  const md = createChangelog({ items: withUntagged, version: "1.2.0", date: "2026-05-28", sectionBy: "label" }).markdown;
  assert.match(md, /### feature\n\n- Add dark mode toggle/);
  assert.match(md, /### bug\n\n- Crash on empty input/);
  assert.match(md, /### docs\n\n- Improve the readme/);
  assert.match(md, /### Unlabeled\n\n- Untagged work/);
});

test("--section-by label deduplicates repeated tags per item", () => {
  const md = createChangelog({
    items: [
      {
        id: "pm-dup",
        title: "Avoid duplicate label output",
        status: "closed",
        type: "Task",
        release: "1.2.0",
        tags: ["docs", "docs", " docs "],
        updated_at: "2026-05-28T06:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-28",
    sectionBy: "label",
  }).markdown;

  assert.equal(md.match(/- Avoid duplicate label output/g)?.length, 1);
});

// ---------------------------------------------------------------------------
// --contributors
// ---------------------------------------------------------------------------
test("--contributors appends a unique contributor list per release", () => {
  const md = createChangelog({ items, version: "1.2.0", date: "2026-05-28", contributors: true }).markdown;
  assert.match(md, /### Contributors\n\n@alice, @bob\n/);
  // alice appears twice as assignee but is listed once.
  assert.equal((md.match(/@alice/g) ?? []).length, 1);
});

test("--contributors falls back to author and ignores the 'unknown' placeholder", () => {
  const itemsAuthor: PmItem[] = [
    { id: "pm-a", title: "Work A", status: "closed", type: "Task", author: "dave", release: "1.0.0", updated_at: "2026-05-20T00:00:00Z" },
    { id: "pm-b", title: "Work B", status: "closed", type: "Task", author: "unknown", release: "1.0.0", updated_at: "2026-05-20T00:00:00Z" },
  ];
  const md = createChangelog({ items: itemsAuthor, version: "1.0.0", date: "2026-05-20", contributors: true }).markdown;
  assert.match(md, /### Contributors\n\n@dave\n/);
  assert.doesNotMatch(md, /@unknown/);
});

test("--contributors emits nothing when no contributor metadata exists", () => {
  const anon: PmItem[] = [{ id: "pm-a", title: "Anon work", status: "closed", type: "Task", release: "1.0.0", updated_at: "2026-05-20T00:00:00Z" }];
  const md = createChangelog({ items: anon, version: "1.0.0", date: "2026-05-20", contributors: true }).markdown;
  assert.doesNotMatch(md, /### Contributors/);
});

// ---------------------------------------------------------------------------
// --limit / --since-version (only act on release-window sections)
// ---------------------------------------------------------------------------
const windowItems: PmItem[] = [
  { id: "pm-1", title: "Newest", status: "closed", type: "Task", release: "1.2.0", updated_at: "2026-05-28T00:00:00Z" },
  { id: "pm-2", title: "Middle", status: "closed", type: "Task", release: "1.1.0", updated_at: "2026-05-20T00:00:00Z" },
  { id: "pm-3", title: "Oldest", status: "closed", type: "Task", release: "1.0.0", updated_at: "2026-05-10T00:00:00Z" },
];
const windows = [
  { heading: "1.2.0 - 2026-05-28", releaseTag: "v1.2.0", until: "2026-05-28T00:00:00Z" },
  { heading: "1.1.0 - 2026-05-20", releaseTag: "v1.1.0", until: "2026-05-20T00:00:00Z" },
  { heading: "1.0.0 - 2026-05-10", releaseTag: "v1.0.0", until: "2026-05-10T00:00:00Z" },
];

test("--limit keeps only the most recent N release sections", () => {
  const md = createChangelog({ items: windowItems, releaseWindows: windows, limit: 2 }).markdown;
  assert.match(md, /## 1\.2\.0 - 2026-05-28/);
  assert.match(md, /## 1\.1\.0 - 2026-05-20/);
  assert.doesNotMatch(md, /## 1\.0\.0/);
});

test("--since-version drops releases older than the given version", () => {
  const md = createChangelog({ items: windowItems, releaseWindows: windows, sinceVersion: "1.1.0" }).markdown;
  assert.match(md, /## 1\.2\.0/);
  assert.match(md, /## 1\.1\.0/);
  assert.doesNotMatch(md, /## 1\.0\.0/);
});

test("--limit / --since-version are no-ops without release windows", () => {
  const base = createChangelog({ items, version: "1.2.0", date: "2026-05-28" }).markdown;
  const limited = createChangelog({ items, version: "1.2.0", date: "2026-05-28", limit: 1, sinceVersion: "9.9.9" }).markdown;
  assert.equal(limited, base);
});

// ---------------------------------------------------------------------------
// --changelog-json (structured document)
// ---------------------------------------------------------------------------
test("buildChangelogDocument returns structured releases->sections->items", () => {
  const doc = buildChangelogDocument({ items, version: "1.2.0", date: "2026-05-28" });
  assert.equal(doc.title, "Changelog");
  assert.equal(doc.section_by, "category");
  assert.equal(doc.item_count, 3);
  assert.equal(doc.releases.length, 1);
  const release = doc.releases[0];
  assert.equal(release.version, "1.2.0");
  assert.equal(release.item_count, 3);
  const added = release.sections.find((s) => s.heading === "Added");
  assert.ok(added);
  assert.equal(added!.items[0].id, "pm-feat");
});

test("buildChangelogDocument honors --conventional and --contributors", () => {
  const doc = buildChangelogDocument({ items, version: "1.2.0", date: "2026-05-28", conventional: true, contributors: true });
  assert.ok(doc.releases[0].sections.some((s) => s.heading === "Features"));
  assert.deepEqual(doc.releases[0].contributors, ["alice", "bob"]);
});
