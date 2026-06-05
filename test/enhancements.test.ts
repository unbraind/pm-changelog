import assert from "node:assert/strict";
import test from "node:test";

import { buildChangelogDocument, createChangelog, suggestSemver } from "../dist/index.js";
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
    breakingChanges: false,
    bodyPreview: undefined,
    emojiPrefix: false,
    suggestSemver: false,
  }).markdown;
  assert.equal(explicitDefaults, base);
  // bodyPreview: 0 and emojiPrefix: false are also pure no-ops.
  const zeroPreview = createChangelog({ items, version: "1.2.0", date: "2026-05-28", bodyPreview: 0 }).markdown;
  assert.equal(zeroPreview, base);
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

test("--section-by label ignores malformed tag values", () => {
  const md = createChangelog({
    items: [
      {
        id: "pm-malformed",
        title: "Handle malformed labels",
        status: "closed",
        type: "Task",
        release: "1.2.0",
        tags: ["docs", 42, null, " docs "] as unknown as string[],
        updated_at: "2026-05-28T06:00:00Z",
      },
      {
        id: "pm-no-array",
        title: "Handle non-array labels",
        status: "closed",
        type: "Task",
        release: "1.2.0",
        tags: "docs" as unknown as string[],
        updated_at: "2026-05-28T05:00:00Z",
      },
    ],
    version: "1.2.0",
    date: "2026-05-28",
    sectionBy: "label",
  }).markdown;

  assert.equal(md.match(/- Handle malformed labels/g)?.length, 1);
  assert.match(md, /### Unlabeled\n\n- Handle non-array labels/);
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

// ---------------------------------------------------------------------------
// --breaking-changes
// ---------------------------------------------------------------------------
const breakingItems: PmItem[] = [
  { id: "pm-brk-tag", title: "Drop legacy API", status: "closed", type: "Feature", tags: ["breaking", "feature"], release: "2.0.0", updated_at: "2026-05-28T09:00:00Z" },
  { id: "pm-brk-flag", title: "Rename config keys", status: "closed", type: "Task", breaking: true, release: "2.0.0", updated_at: "2026-05-28T08:30:00Z" },
  { id: "pm-brk-title", title: "BREAKING: remove --old flag", status: "closed", type: "Task", release: "2.0.0", updated_at: "2026-05-28T08:15:00Z" },
  { id: "pm-normal", title: "Add a new widget", status: "closed", type: "Feature", tags: ["feature"], release: "2.0.0", updated_at: "2026-05-28T08:00:00Z" },
];

test("--breaking-changes emits a Breaking Changes section listing detected items", () => {
  const md = createChangelog({ items: breakingItems, version: "2.0.0", date: "2026-05-28", breakingChanges: true }).markdown;
  assert.match(md, /### Breaking Changes\n/);
  assert.match(md, /### Breaking Changes\n\n- Drop legacy API/);
  assert.match(md, /- Rename config keys/);
  assert.match(md, /- BREAKING: remove --old flag/);
  // The non-breaking item must NOT appear under Breaking Changes.
  const breakingBlock = md.slice(md.indexOf("### Breaking Changes"));
  const nextHeading = breakingBlock.indexOf("\n### ", 5);
  const section = nextHeading >= 0 ? breakingBlock.slice(0, nextHeading) : breakingBlock;
  assert.doesNotMatch(section, /Add a new widget/);
});

test("--breaking-changes is absent by default (byte-identical)", () => {
  const def = createChangelog({ items: breakingItems, version: "2.0.0", date: "2026-05-28" }).markdown;
  assert.doesNotMatch(def, /Breaking Changes/);
});

test("--breaking-changes surfaces in the structured document", () => {
  const doc = buildChangelogDocument({ items: breakingItems, version: "2.0.0", date: "2026-05-28", breakingChanges: true });
  const ids = (doc.releases[0].breaking_changes ?? []).map((i) => i.id);
  assert.deepEqual(ids.sort(), ["pm-brk-flag", "pm-brk-tag", "pm-brk-title"]);
});

// ---------------------------------------------------------------------------
// --suggest-semver
// ---------------------------------------------------------------------------
test("--suggest-semver recommends major when a breaking change is present", () => {
  const s = suggestSemver({ items: breakingItems, version: "2.0.0", date: "2026-05-28" });
  assert.equal(s.bump, "major");
  assert.equal(s.counts.breaking, 3);
});

test("--suggest-semver recommends minor for features only", () => {
  const feats: PmItem[] = [
    { id: "f1", title: "Add A", status: "closed", type: "Feature", tags: ["feature"], updated_at: "2026-05-28T09:00:00Z" },
    { id: "fx", title: "Fix B", status: "closed", type: "Issue", tags: ["bug"], updated_at: "2026-05-28T08:00:00Z" },
  ];
  const s = suggestSemver({ items: feats });
  assert.equal(s.bump, "minor");
  assert.equal(s.counts.feature, 1);
  assert.equal(s.counts.fix, 1);
});

test("--suggest-semver recommends patch for fixes only and none when empty", () => {
  const fixOnly = suggestSemver({ items: [{ id: "x", title: "Fix crash", status: "closed", type: "Issue", tags: ["bug"], updated_at: "2026-05-28T08:00:00Z" }] });
  assert.equal(fixOnly.bump, "patch");
  const empty = suggestSemver({ items: [] });
  assert.equal(empty.bump, "none");
});

test("--suggest-semver only surfaces in the document when opted in", () => {
  const withFlag = buildChangelogDocument({ items: breakingItems, version: "2.0.0", date: "2026-05-28", suggestSemver: true });
  assert.equal(withFlag.suggested_semver?.bump, "major");
  const without = buildChangelogDocument({ items: breakingItems, version: "2.0.0", date: "2026-05-28" });
  assert.equal(without.suggested_semver, undefined);
});

// ---------------------------------------------------------------------------
// --body-preview
// ---------------------------------------------------------------------------
const bodyItems: PmItem[] = [
  { id: "pm-body", title: "Add export", status: "closed", type: "Feature", tags: ["feature"], body: "This adds a CSV export pipeline with streaming support and resumable jobs.", updated_at: "2026-05-28T09:00:00Z" },
  { id: "pm-short", title: "Tiny fix", status: "closed", type: "Issue", tags: ["bug"], body: "ok", updated_at: "2026-05-28T08:00:00Z" },
  { id: "pm-nobody", title: "No body item", status: "closed", type: "Task", updated_at: "2026-05-28T07:00:00Z" },
];

test("--body-preview appends a truncated body with an ellipsis", () => {
  const md = createChangelog({ items: bodyItems, version: "1.0.0", date: "2026-05-28", bodyPreview: 20 }).markdown;
  assert.match(md, /- Add export \(pm-body\) — This adds a CSV expo…/);
  // Short body is not truncated and has no ellipsis.
  assert.match(md, /- Tiny fix \(pm-short\) — ok\n/);
  // Item without a body renders exactly as default (no separator).
  assert.match(md, /- No body item \(pm-nobody\)\n/);
});

test("--body-preview off by default leaves entries unchanged", () => {
  const def = createChangelog({ items: bodyItems, version: "1.0.0", date: "2026-05-28" }).markdown;
  assert.doesNotMatch(def, /—/);
});

test("--body-preview falls back to description when body is empty (real pm items)", () => {
  // pm workspaces store prose in `description`; `body` is usually "". The
  // preview must use `description` so the flag isn't a silent no-op.
  const items: PmItem[] = [
    { id: "pm-desc", title: "Desc only", status: "closed", type: "Feature", tags: ["feature"], body: "", description: "Adds a streaming CSV export with resumable jobs.", updated_at: "2026-05-28T09:00:00Z" },
    { id: "pm-both", title: "Both fields", status: "closed", type: "Feature", tags: ["feature"], body: "BODY wins", description: "description ignored", updated_at: "2026-05-28T08:00:00Z" },
  ];
  const md = createChangelog({ items, version: "1.0.0", date: "2026-05-28", bodyPreview: 24 }).markdown;
  assert.match(md, /- Desc only \(pm-desc\) — Adds a streaming CSV/);
  // A non-empty body still takes precedence over description.
  assert.match(md, /- Both fields \(pm-both\) — BODY wins/);
});

// ---------------------------------------------------------------------------
// --emoji-prefix
// ---------------------------------------------------------------------------
test("--emoji-prefix prefixes known category headings", () => {
  const md = createChangelog({ items, version: "1.2.0", date: "2026-05-28", emojiPrefix: true }).markdown;
  assert.match(md, /### 🎉 Added\n/);
  assert.match(md, /### 🐛 Fixed\n/);
  // Item lines are unchanged.
  assert.match(md, /- Add dark mode toggle/);
});

test("--emoji-prefix composes with --conventional headings", () => {
  const md = createChangelog({ items, version: "1.2.0", date: "2026-05-28", emojiPrefix: true, conventional: true }).markdown;
  assert.match(md, /### 🎉 Features\n/);
  assert.match(md, /### 🐛 Bug Fixes\n/);
});

test("--emoji-prefix leaves unknown headings (custom labels) unchanged", () => {
  const md = createChangelog({ items, version: "1.2.0", date: "2026-05-28", emojiPrefix: true, sectionBy: "label" }).markdown;
  // "feature"/"bug"/"docs" are not in the emoji map and must pass through.
  assert.match(md, /### feature\n/);
  assert.match(md, /### docs\n/);
});

test("--emoji-prefix and --breaking-changes compose", () => {
  const md = createChangelog({ items: breakingItems, version: "2.0.0", date: "2026-05-28", emojiPrefix: true, breakingChanges: true }).markdown;
  assert.match(md, /### 💥 Breaking Changes\n/);
});
