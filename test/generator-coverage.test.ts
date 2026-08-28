/**
 * Targeted coverage tests for generator.ts branches the main generator suite
 * does not already exercise. Each case drives the exported generator surface
 * (createChangelog, buildChangelogDocument, createChangelogSummary,
 * formatSummaryLine, mergeChangelog, writeChangelog, parsePmItemsJson,
 * formatInferredSources, suggestSemver, visibleChangelogItems,
 * explainChangelogSelection) with crafted `PmItem` fixtures, so the coverage is
 * attributed to the in-process module load. Behaviour already pinned by
 * generator.test.ts is not duplicated here.
 */
import { describe, it } from "node:test";
import { equal, match, ok, throws } from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildChangelogDocument,
  generateChangelog,
  createChangelog,
  createChangelogSummary,
  explainChangelogSelection,
  formatSummaryLine,
  mergeChangelog,
  parsePmItemsJson,
  readPmItems,
  suggestSemver,
  writeChangelog,
} from "../src/index.ts";
import { compareVersionHeadings, compareVersionStrings, formatInferredSources, visibleChangelogItems } from "../src/generator.ts";
import type {
  ChangelogReleaseWindow,
  ChangelogSummaryEntry,
  PmItem,
} from "../src/types.ts";

/** A closed item with the given id, title, and optional overrides. */
function item(overrides: Partial<PmItem> & { id: string; title: string }): PmItem {
  return { status: "closed", updated_at: "2026-06-01T00:00:00Z", ...overrides };
}

describe("generator: classification categories", () => {
  it("routes security-tagged items to a Security section", () => {
    const result = createChangelog({ items: [item({ id: "s1", title: "Patch CVE leak", tags: ["security"] })] });
    match(result.markdown, /### Security\n\n- Patch CVE leak \(s1\)/);
  });

  it("routes deprecated items to a Deprecated section", () => {
    const result = createChangelog({ items: [item({ id: "d1", title: "Retire old API", type: "deprecation" })] });
    match(result.markdown, /### Deprecated\n\n- Retire old API \(d1\)/);
  });
});

describe("generator: summary and document item projection", () => {
  it("formatSummaryLine falls back to the heading when version is absent and omits the id suffix", () => {
    const withId: ChangelogSummaryEntry = { heading: "1.2.0 - 2026-06-01", category: "Added", id: "pm-1", title: "Add a thing" };
    equal(formatSummaryLine(withId), "[1.2.0] Added: Add a thing (pm-1)");
    const noVersionNoId: ChangelogSummaryEntry = { heading: "Unreleased - 2026-06-01", category: "Fixed", title: "Fix a thing" };
    equal(formatSummaryLine(noVersionNoId), "[Unreleased] Fixed: Fix a thing");
  });

  it("createChangelogSummary projects items missing type and status fields", () => {
    // The summary entry narrows type/status to undefined when the item's value
    // is not a string. An empty includeStatuses list accepts the item even
    // though its status is absent, so both typeof guards are exercised.
    const noTypeNoStatus: PmItem = { title: "Untitled work", updated_at: "2026-06-01T00:00:00Z" };
    const entries = createChangelogSummary({ items: [noTypeNoStatus], includeStatuses: [] });
    equal(entries.length, 1);
    equal(entries[0].type, undefined);
    equal(entries[0].status, undefined);
  });

  it("createChangelogSummary skips empty release-window sections under includeEmpty", () => {
    // A window with no matching items yields an empty section the summary loop
    // continues past, while a window with items still produces entries.
    const windows: ChangelogReleaseWindow[] = [
      { heading: "1.0.0 - 2026-01-01", releaseTag: "v1.0.0", until: "2026-01-02T00:00:00Z" },
      { heading: "1.1.0 - 2026-02-01", releaseTag: "v1.1.0", since: "2026-01-02T00:00:00Z", sinceExclusive: true, until: "2026-03-01T00:00:00Z" },
    ];
    const entries = createChangelogSummary({
      items: [item({ id: "pm-1", title: "Add feature", updated_at: "2026-02-10T00:00:00Z" })],
      releaseWindows: windows,
      includeEmpty: true,
    });
    ok(entries.length > 0);
    ok(entries.every((entry) => entry.title === "Add feature"));
  });
});

describe("generator: status and release-window filtering", () => {
  it("treats an explicit empty includeStatuses list as accept-all", () => {
    const open: PmItem = { title: "Open work", status: "open", updated_at: "2026-06-01T00:00:00Z" };
    const result = createChangelog({ items: [open], includeStatuses: [] });
    match(result.markdown, /- Open work/);
  });

  it("filters by a specific status set", () => {
    const open: PmItem = { title: "Open work", status: "open", updated_at: "2026-06-01T00:00:00Z" };
    const result = createChangelog({ items: [open], includeStatuses: ["closed"] });
    equal(result.itemCount, 0);
  });

  it("drops items whose timestamp is unparseable inside a bounded window", () => {
    const bad: PmItem = { title: "Bad date", status: "closed", updated_at: "not-a-date" };
    const good: PmItem = { title: "Good date", status: "closed", updated_at: "2026-02-10T00:00:00Z" };
    const result = createChangelog({
      items: [bad, good],
      since: "2026-02-01T00:00:00Z",
      until: "2026-03-01T00:00:00Z",
    });
    equal(result.itemCount, 1);
    match(result.markdown, /- Good date/);
  });

  it("dedupes release windows that normalize to the same key and leaves empty buckets", () => {
    // Two windows with tags that normalize identically ("v1.0.0" and "1.0.0")
    // exercise the releaseIndex dedup `continue`, and an item with no matching
    // release falls through to time placement, leaving a window empty.
    const windows: ChangelogReleaseWindow[] = [
      { heading: "1.0.0 - 2026-01-01", releaseTag: "v1.0.0" },
      { heading: "1.0.0-dup - 2026-01-01", releaseTag: "1.0.0" },
      { heading: "Unreleased - 2026-06-01" },
    ];
    const result = createChangelog({
      items: [item({ id: "pm-1", title: "Add feature", release: "1.0.0", updated_at: "2026-01-05T00:00:00Z" })],
      releaseWindows: windows,
      includeEmpty: true,
    });
    ok(result.markdown.includes("1.0.0 -"));
  });
});

describe("generator: grouping by release and milestone", () => {
  it("groups items by release field, sorting the Unreleased fallback first", () => {
    const result = createChangelog({
      items: [
        item({ id: "a", title: "Released work", release: "2.0.0", updated_at: "2026-05-01T00:00:00Z" }),
        item({ id: "b", title: "Unscoped work", updated_at: "2026-05-02T00:00:00Z" }),
      ],
      groupBy: "release",
    });
    // The Unreleased fallback heading sorts ahead of the versioned releases.
    const unreleasedIdx = result.markdown.indexOf("## Unreleased");
    const releasedIdx = result.markdown.indexOf("## 2.0.0");
    ok(unreleasedIdx !== -1 && releasedIdx !== -1 && unreleasedIdx < releasedIdx);
  });

  it("groups items by milestone field", () => {
    const result = createChangelog({
      items: [item({ id: "a", title: "Milestone work", milestone: "Sprint 1", updated_at: "2026-05-01T00:00:00Z" })],
      groupBy: "milestone",
    });
    match(result.markdown, /## Sprint 1/);
  });

  it("sections by type, bucketing items with no type under Other", () => {
    const result = createChangelog({
      items: [
        item({ id: "a", title: "Typed work", type: "feature", updated_at: "2026-05-01T00:00:00Z" }),
        { id: "b", title: "Untyped work", status: "closed", updated_at: "2026-05-02T00:00:00Z" },
      ],
      sectionBy: "type",
    });
    match(result.markdown, /### Other\n\n- Untyped work \(b\)/);
    match(result.markdown, /### Feature\n\n- Typed work \(a\)/);
  });
});

describe("generator: version comparison and section limiting", () => {
  it("limitSections keeps Unreleased and unparsable headings under --since-version", () => {
    const windows: ChangelogReleaseWindow[] = [
      { heading: "Unreleased - 2026-06-01" },
      { heading: "1.2.0 - 2026-05-01", releaseTag: "v1.2.0" },
      { heading: "1.1.0 - 2026-04-01", releaseTag: "v1.1.0" },
    ];
    const items = [
      item({ id: "new", title: "New", updated_at: "2026-06-01T00:00:00Z" }),
      item({ id: "v12", title: "In 1.2.0", updated_at: "2026-05-01T00:00:00Z" }),
      item({ id: "v11", title: "In 1.1.0", updated_at: "2026-04-01T00:00:00Z" }),
    ];
    const result = createChangelog({ items, releaseWindows: windows, sinceVersion: "1.2.0", includeEmpty: true });
    // 1.1.0 is dropped; Unreleased and 1.2.0 remain.
    match(result.markdown, /## 1\.2\.0/);
    ok(!result.markdown.includes("## 1.1.0"), "older release filtered by sinceVersion");
    ok(result.markdown.includes("## Unreleased"), "Unreleased kept under sinceVersion");
  });

  it("limitSections caps the number of release sections", () => {
    const windows: ChangelogReleaseWindow[] = [
      { heading: "1.3.0 - 2026-06-01", releaseTag: "v1.3.0" },
      { heading: "1.2.0 - 2026-05-01", releaseTag: "v1.2.0" },
      { heading: "1.1.0 - 2026-04-01", releaseTag: "v1.1.0" },
    ];
    const items = windows.map((w, i) => item({ id: `i${i}`, title: w.heading, updated_at: `2026-0${i + 4}-01T00:00:00Z` }));
    const result = createChangelog({ items, releaseWindows: windows, limit: 2 });
    ok(result.markdown.includes("## 1.3.0"));
    ok(!result.markdown.includes("## 1.1.0"), "limit drops the oldest release");
  });
});

describe("generator: merge and prepend insertion", () => {
  it("replaceChangelog inserts a release under a title-less file via insertAfterTitle", () => {
    // No `# Title` heading → ensureTitle adds one and the section is inserted.
    const generated = createChangelog({ items: [item({ id: "a", title: "Add a thing", updated_at: "2026-06-01T00:00:00Z" })], version: "1.2.0", date: "2026-06-01" });
    const merged = mergeChangelog("# Changelog\n\n## Older - 2026-01-01\n\n- Old\n", generated.markdown, { title: "Changelog" });
    match(merged.markdown, /# Changelog/);
    ok(merged.markdown.includes("## 1.2.0"));
  });

  it("prepend merge inserts a backfilled older release in chronological position", () => {
    // An existing changelog with 1.2.0 and Unreleased; prepend a 1.1.0 section
    // that has no existing heading, so insertReleaseSection places it before 1.2.0.
    const generated = createChangelog({ items: [item({ id: "old", title: "Old work", updated_at: "2026-04-01T00:00:00Z" })], version: "1.1.0", date: "2026-04-01" });
    const existing = "# Changelog\n\n## Unreleased\n\n- Pending\n\n## 1.2.0 - 2026-05-01\n\n- Newer\n";
    const merged = mergeChangelog(existing, generated.markdown, { title: "Changelog" });
    const unreleasedIdx = merged.markdown.indexOf("## Unreleased");
    const v110Idx = merged.markdown.indexOf("## 1.1.0");
    const v120Idx = merged.markdown.indexOf("## 1.2.0");
    ok(v110Idx !== -1, "1.1.0 inserted");
    ok(unreleasedIdx < v110Idx && v110Idx < v120Idx, "1.1.0 placed between Unreleased and 1.2.0");
  });

  it("prepend merge appends a section older than every existing one", () => {
    // A new 0.9.0 section sorts after all existing releases (no insertBefore).
    const generated = createChangelog({ items: [item({ id: "old", title: "Old work", updated_at: "2026-01-01T00:00:00Z" })], version: "0.9.0", date: "2026-01-01" });
    const existing = "# Changelog\n\n## 1.2.0 - 2026-05-01\n\n- Newer\n";
    const merged = mergeChangelog(existing, generated.markdown, { title: "Changelog" });
    const v090Idx = merged.markdown.indexOf("## 0.9.0");
    const v120Idx = merged.markdown.indexOf("## 1.2.0");
    ok(v090Idx > v120Idx, "0.9.0 appended after the newer release");
  });

  it("ensureTitle adds the default title to a file lacking one", () => {
    const generated = createChangelog({ items: [item({ id: "a", title: "Add", updated_at: "2026-06-01T00:00:00Z" })], version: "1.0.0", date: "2026-06-01" });
    const merged = mergeChangelog("## 1.0.0 - 2026-01-01\n\n- Old\n", generated.markdown, {});
    match(merged.markdown, /^# Changelog\n/);
  });
});

describe("generator: item references and links", () => {
  it("renders a github reference from a gh:owner/repo#N provenance tag", () => {
    const result = createChangelog({
      items: [item({ id: "pm-1", title: "Add feature", tags: ["gh:unbraind/pm-changelog#42"], updated_at: "2026-06-01T00:00:00Z" })],
      itemRefStyle: "github",
    });
    match(result.markdown, /\(\[#42\]\(https:\/\/github\.com\/unbraind\/pm-changelog\/issues\/42\)\)/);
  });

  it("falls back to a label when github style lacks provenance", () => {
    const result = createChangelog({
      items: [item({ id: "pm-1", title: "Add feature", updated_at: "2026-06-01T00:00:00Z" })],
      itemRefStyle: "github",
    });
    match(result.markdown, /\(pm-1\)/);
    ok(!result.markdown.includes("github.com"));
  });

  it("renders a toon blob link under itemUrlBase and maps item type to a directory", () => {
    const result = createChangelog({
      items: [item({ id: "pm-1", title: "Add feature", type: "story", updated_at: "2026-06-01T00:00:00Z" })],
      itemRefStyle: "toon",
      itemUrlBase: "https://example.com/blob",
    });
    match(result.markdown, /\(\[pm-1\]\(https:\/\/example\.com\/blob\/stories\/pm-1\.toon\)\)/);
  });

  it("falls back to a label when toon style has no itemUrlBase", () => {
    const result = createChangelog({
      items: [item({ id: "pm-1", title: "Add feature", updated_at: "2026-06-01T00:00:00Z" })],
      itemRefStyle: "toon",
    });
    match(result.markdown, /\(pm-1\)/);
  });

  it("omits the id reference for an item with no id", () => {
    const result = createChangelog({
      items: [{ title: "No id work", status: "closed", updated_at: "2026-06-01T00:00:00Z" }],
    });
    match(result.markdown, /^- No id work$/m);
  });

  it("includes an https item link and drops non-http and invalid urls", () => {
    const result = createChangelog({
      items: [
        item({ id: "a", title: "Has link", url: "https://example.com/page?token=secret#frag", updated_at: "2026-06-01T00:00:00Z" }),
        item({ id: "b", title: "Bad protocol", url: "ftp://example.com/x", updated_at: "2026-06-01T00:00:00Z" }),
        item({ id: "c", title: "Invalid url", url: "not a url", updated_at: "2026-06-01T00:00:00Z" }),
      ],
      includeLinks: true,
    });
    match(result.markdown, /\[link\]\(https:\/\/example\.com\/page\)/);
    ok(!result.markdown.includes("ftp://"), "non-http url dropped");
    ok(!result.markdown.includes("[link](not"), "invalid url dropped");
  });
});

describe("generator: breaking-change detection and semver suggestion", () => {
  it("suggests a major bump for a boolean breaking flag", () => {
    const suggestion = suggestSemver({ items: [item({ id: "a", title: "Break", breaking: true, updated_at: "2026-06-01T00:00:00Z" })] });
    equal(suggestion.bump, "major");
  });

  it("suggests a major bump for a numeric metadata breaking flag", () => {
    const suggestion = suggestSemver({ items: [item({ id: "a", title: "Break", metadata: { breaking: 1 }, updated_at: "2026-06-01T00:00:00Z" })] });
    equal(suggestion.bump, "major");
  });

  it("suggests a major bump for a breaking tag and a breaking title token", () => {
    const suggestion = suggestSemver({ items: [item({ id: "a", title: "This is breaking for users", tags: ["breaking-change"], updated_at: "2026-06-01T00:00:00Z" })] });
    equal(suggestion.bump, "major");
  });

  it("does not flag a non-breaking title", () => {
    const suggestion = suggestSemver({ items: [item({ id: "a", title: "Non-breaking refactor", updated_at: "2026-06-01T00:00:00Z" })] });
    ok(suggestion.bump !== "major", "a non-breaking item must not suggest a major bump");
  });
});

describe("generator: explain and visible-items diagnostics", () => {
  it("explainChangelogSelection reports attribution under --respect-item-release", () => {
    const report = explainChangelogSelection({
      items: [
        item({ id: "a", title: "In release", release: "1.2.0", updated_at: "2026-04-01T00:00:00Z" }),
        item({ id: "b", title: "Out of window", release: "1.1.0", updated_at: "2026-06-01T00:00:00Z" }),
      ],
      version: "1.2.0",
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-15T00:00:00Z",
      respectItemRelease: true,
    });
    ok(report.stage_counts !== undefined);
  });

  it("explainChangelogSelection reports release-window exclusions under --all-release-tags", () => {
    const windows: ChangelogReleaseWindow[] = [
      { heading: "1.0.0 - 2026-01-01", releaseTag: "v1.0.0", until: "2026-01-02T00:00:00Z" },
    ];
    const report = explainChangelogSelection({
      items: [item({ id: "a", title: "Far future", updated_at: "2026-12-01T00:00:00Z" })],
      releaseWindows: windows,
    });
    ok(report.stage_counts !== undefined);
  });

  it("explainChangelogSelection samples inferred late-close candidates", () => {
    // Items with only updated_at (no completed_at/closed_at) are inferred; more
    // than the sample limit and duplicate labels exercise the sort, limit, and
    // de-dup paths of buildAttributionProvenance.
    const inferred: PmItem[] = Array.from({ length: 5 }, (_, i) => ({
      id: `pm-${i}`,
      title: "Same inferred",
      status: "closed",
      updated_at: `2026-0${i + 1}-01T00:00:00Z`,
    }));
    // Add an item with no id to exercise the (no-id) label fallback.
    const noId: PmItem = { title: "No id inferred", status: "closed", updated_at: "2026-07-01T00:00:00Z" };
    const report = explainChangelogSelection({
      items: [...inferred, noId],
      version: "1.2.0",
    });
    ok(report.attribution_provenance !== undefined);
  });

  it("visibleChangelogItems returns items across non-empty sections only by default", () => {
    const windows: ChangelogReleaseWindow[] = [
      { heading: "1.0.0 - 2026-01-01", releaseTag: "v1.0.0", until: "2026-01-02T00:00:00Z" },
      { heading: "1.1.0 - 2026-02-01", releaseTag: "v1.1.0", since: "2026-01-02T00:00:00Z", sinceExclusive: true, until: "2026-03-01T00:00:00Z" },
    ];
    const visible = visibleChangelogItems({
      items: [item({ id: "a", title: "In 1.1", updated_at: "2026-02-10T00:00:00Z" })],
      releaseWindows: windows,
      includeEmpty: true,
    });
    equal(visible.length, 1);
  });
});

describe("generator: misc exported helpers", () => {
  it("formatInferredSources returns fallback for an empty source map", () => {
    equal(formatInferredSources({}), "fallback");
    equal(formatInferredSources({ closed_at: 2, updated_at: 1 }), "closed_at,updated_at");
  });

  it("parsePmItemsJson accepts the { items: [...] } envelope and throws on invalid shapes", () => {
    equal(parsePmItemsJson(JSON.stringify({ items: [{ title: "x" }] })).length, 1);
    throws(() => parsePmItemsJson(JSON.stringify({ nope: 1 })), /Expected pm JSON/);
  });

  it("readPmItems throws when the pm command exits non-zero", () => {
    // Point at a binary that exists but exits non-zero (`false`), so the
    // status !== 0 branch fires. Use a stable coreutil that always fails.
    throws(
      () => readPmItems({ pmBin: "false" }),
      /failed/,
    );
  });
});

describe("generator: writeChangelog modes", () => {
  it("resolves the default CHANGELOG.md path and prepend-merges in check mode without writing", () => {
    // `output` omitted exercises the `?? "CHANGELOG.md"` default, resolved
    // against the package cwd; check mode reads the real CHANGELOG.md and
    // reports drift without touching disk.
    const result = writeChangelog({
      items: [item({ id: "a", title: "New work", updated_at: "2026-06-01T00:00:00Z" })],
      version: "1.2.0",
      date: "2026-06-01",
      mode: "prepend",
      check: true,
    });
    equal(result.changed, true);
    match(result.markdown, /# Changelog/);
  });

  it("check mode reports drift without writing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-changelog-wc2-"));
    try {
      const out = join(dir, "CHANGELOG.md");
      writeFileSync(out, "stale\n", "utf-8");
      const result = writeChangelog({
        items: [item({ id: "a", title: "New work", updated_at: "2026-06-01T00:00:00Z" })],
        version: "1.2.0",
        date: "2026-06-01",
        mode: "replace",
        check: true,
        output: out,
      });
      equal(result.changed, true);
      equal(readFileSync(out, "utf-8"), "stale\n", "check mode must not write");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generator: title markdown escaping", () => {
  it("escapes a leading underscore in a title", () => {
    // A title starting with `_` exercises escapeItemTitleText's `previous ?? ""`
    // arm (index 0 has no previous character).
    const result = createChangelog({ items: [item({ id: "a", title: "_underscored start", updated_at: "2026-06-01T00:00:00Z" })] });
    match(result.markdown, /\\_underscored start/);
  });

  it("preserves a code span in a title while escaping surrounding markdown", () => {
    const result = createChangelog({ items: [item({ id: "a", title: "Use `--flag` value", updated_at: "2026-06-01T00:00:00Z" })] });
    match(result.markdown, /`--flag`/);
  });
});

describe("generator: buildChangelogDocument includeEmpty", () => {
  it("emits empty release sections under includeEmpty", () => {
    const windows: ChangelogReleaseWindow[] = [
      { heading: "1.0.0 - 2026-01-01", releaseTag: "v1.0.0", until: "2026-01-02T00:00:00Z" },
      { heading: "1.1.0 - 2026-02-01", releaseTag: "v1.1.0", since: "2026-01-02T00:00:00Z", sinceExclusive: true, until: "2026-03-01T00:00:00Z" },
    ];
    const doc = buildChangelogDocument({
      items: [item({ id: "a", title: "In 1.1", updated_at: "2026-02-10T00:00:00Z" })],
      releaseWindows: windows,
      includeEmpty: true,
    });
    ok(doc.releases.length >= 2, "includeEmpty emits both windows");
  });
});
// --- remaining branch coverage ----------------------------------------------

describe("generator: empty and no-release-section paths", () => {
  it("createChangelog emits a No changes section under includeEmpty with no sections", () => {
    // groupBy release with zero items yields no sections, so the
    // sections.length === 0 + includeEmpty branch emits a placeholder.
    const result = createChangelog({ items: [], groupBy: "release", includeEmpty: true });
    match(result.markdown, /No changes\./);
    match(result.markdown, /## Unreleased/);
  });

  it("createChangelog returns only the title when sections are empty and includeEmpty is off", () => {
    const result = createChangelog({ items: [], groupBy: "release" });
    match(result.markdown, /^# Changelog\n$/);
  });

  it("mergeChangelog leaves an existing file unchanged when the generated side has no releases", () => {
    // Generated markdown with no `##` headings -> extractReleaseSections returns
    // [] -> the releaseSections.length === 0 unchanged branch.
    const generated = createChangelog({ items: [], groupBy: "release" }).markdown;
    const merged = mergeChangelog("# Changelog\n\n## Existing\n\n- Old\n", generated, {});
    equal(merged.action, "unchanged");
  });
});

describe("generator: status filter with absent status", () => {
  it("treats an item with no status as not matching a non-empty status set", () => {
    // An item whose status is undefined hits the `item.status ?? ""` arm of the
    // status filter against a non-empty statuses set, and is excluded.
    const noStatus: PmItem = { title: "No status", updated_at: "2026-06-01T00:00:00Z" };
    const result = createChangelog({ items: [noStatus], includeStatuses: ["closed"] });
    equal(result.itemCount, 0);
  });
});

describe("generator: single-version-section under release windows", () => {
  it("explainChangelogSelection skips attribution when release windows are present", () => {
    // usesSingleVersionSection returns false under releaseWindows, so
    // attributionApplies is false even with respectItemRelease set.
    const windows: ChangelogReleaseWindow[] = [
      { heading: "1.0.0 - 2026-01-01", releaseTag: "v1.0.0", until: "2026-01-02T00:00:00Z" },
    ];
    const report = explainChangelogSelection({
      items: [item({ id: "a", title: "x", release: "1.0.0", updated_at: "2026-01-01T00:00:00Z" })],
      releaseWindows: windows,
      respectItemRelease: true,
    });
    equal(report.stage_counts.after_item_release, undefined);
  });
});

describe("generator: version-heading comparison edges", () => {
  it("sorts release groupings with differing segment counts and the Unreleased fallback", () => {
    // Three releases including the Unreleased fallback and versions with
    // different segment counts exercise both compareVersionHeadings fallback
    // arms and both compareVersionStrings missing-segment arms.
    const result = createChangelog({
      items: [
        item({ id: "a", title: "A", release: "1.0", updated_at: "2026-05-01T00:00:00Z" }),
        item({ id: "b", title: "B", release: "1.0.0", updated_at: "2026-05-02T00:00:00Z" }),
        item({ id: "c", title: "C", release: "2.0", updated_at: "2026-05-03T00:00:00Z" }),
        item({ id: "d", title: "Unscoped", updated_at: "2026-05-04T00:00:00Z" }),
      ],
      groupBy: "release",
    });
    ok(result.markdown.includes("## Unreleased"));
    ok(result.markdown.includes("## 1.0"));
    ok(result.markdown.includes("## 1.0.0"));
    ok(result.markdown.includes("## 2.0"));
  });
});

describe("generator: bracketed and Unreleased heading insertion", () => {
  it("merges a bracketed existing heading and inserts an Unreleased section before versions", () => {
    // An existing heading of the form `[1.0.0](url) - date` exercises the
    // bracketed arm of normalizeReleaseHeadingKey. A generated Unreleased
    // section with no existing heading inserts before the first version
    // (newKey === UNRELEASED).
    const generated = createChangelog({ items: [item({ id: "new", title: "Pending work", updated_at: "2026-06-01T00:00:00Z" })] });
    const existing = "# Changelog\n\n[1.0.0](https://example.com) - 2026-01-01\n\n- Old\n";
    const merged = mergeChangelog(existing, generated.markdown, { title: "Changelog" });
    const unreleasedIdx = merged.markdown.indexOf("## Unreleased");
    const v100Idx = merged.markdown.indexOf("[1.0.0]");
    ok(unreleasedIdx !== -1 && v100Idx !== -1 && unreleasedIdx < v100Idx, "Unreleased inserted before the bracketed version");
  });

  it("insertReleaseSection falls back to insertAfterTitle when no release headings exist", () => {
    // Existing has a title but no `##` sections, so insertReleaseSection's
    // matches.length === 0 branch routes to insertAfterTitle.
    const generated = createChangelog({ items: [item({ id: "a", title: "New work", updated_at: "2026-06-01T00:00:00Z" })], version: "1.2.0", date: "2026-06-01" });
    const merged = mergeChangelog("# Changelog\n\nSome intro prose.\n", generated.markdown, { title: "Changelog" });
    ok(merged.markdown.includes("## 1.2.0"));
    ok(merged.markdown.includes("Some intro prose."));
  });

  it("falls back safely for malformed bracketed headings and CRLF input", () => {
    // Exercise every malformed branch of the linear bracket parser: empty
    // labels, empty URLs, missing separator spacing, missing date text, and a
    // line terminator in the date suffix. CRLF also exercises line-end removal.
    for (const heading of [
      "[]",
      "[1.0.0]()",
      "[1.0.0] trailing",
      "[1.0.0]-date",
      "[1.0.0] -",
      "[1.0.0] - ",
      "[1.0.0] - date\u2028x",
    ]) {
      const existing = `# Changelog\r\n\r\n## ${heading}\r\n\r\n### Fixed\r\n\r\n- Old\r\n`;
      const generated = "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n### Fixed\n\n- New\n";
      const merged = mergeChangelog(existing, generated);
      ok(merged.markdown.includes("- New"), `malformed heading was not safely bypassed: ${heading}`);
    }
  });

  it("matches release headings across CR-only and Unicode line terminators", () => {
    // findMarkdownHeadings must treat every ECMAScript line terminator as a
    // boundary, not only \n. A CR-only document and \u2028 separators exercise
    // the general terminator path; the old \n-only scan saw the whole document
    // as one line and never matched the existing release, so replace would
    // duplicate instead of merging.
    for (const terminator of ["\r", "\u2028", "\u2029"]) {
      const existing = [`# Changelog`, ``, `## 1.0.0 - 2026-01-01`, ``, `### Fixed`, ``, `- Old`].join(terminator);
      const generated = "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n### Fixed\n\n- New\n";
      const merged = mergeChangelog(existing, generated);
      ok(merged.markdown.includes("- New"), `CR/Unicode terminator did not merge: ${JSON.stringify(terminator)}`);
      ok(!merged.markdown.includes("- Old"), `CR/Unicode terminator left the old entry: ${JSON.stringify(terminator)}`);
    }
    // A bare CR at the very end (no following code unit) exercises the
    // lineStart < markdown.length guard in the \r\n advance, where the
    // short-circuit must stop without indexing past the end.
    const trailingCr = "# Changelog\r\r## 1.0.0 - 2026-01-01\r\r### Fixed\r\r- Old\r";
    const trailingMerged = mergeChangelog(trailingCr, "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n### Fixed\n\n- New\n");
    ok(trailingMerged.markdown.includes("- New"), "trailing bare CR did not merge");
    ok(!trailingMerged.markdown.includes("- Old"), "trailing bare CR left the old entry");
  });
});

describe("generator: item metadata and completion edges", () => {
  it("omits the metadata trailer for an item with no metadata fields", () => {
    // formatItemMetadata returns "" when no type/status/priority/release/milestone
    // is present, exercising the parts.length === 0 branch. An empty
    // includeStatuses list admits the status-less item so it renders.
    const result = createChangelog({
      items: [{ id: "a", title: "Plain item", updated_at: "2026-06-01T00:00:00Z" }],
      includeMetadata: true,
      includeStatuses: [],
    });
    // The entry has no trailing italic metadata block.
    match(result.markdown, /- Plain item \(a\)$/m);
  });

  it("detects breaking from a title token when the type is absent", () => {
    // isBreakingItem's haystack typeof guard for type (false arm) still scans
    // the title, finding the standalone "breaking" token.
    const suggestion = suggestSemver({
      items: [{ id: "a", title: "breaking rewrite of the API", status: "closed", updated_at: "2026-06-01T00:00:00Z" }],
    });
    equal(suggestion.bump, "major");
  });
});

describe("generator: sample dedup and limit", () => {
  it("samples a bounded, de-duplicated set of status-excluded items", () => {
    // Five open items (default filter is closed) with duplicate labels and more
    // than the sample limit exercise sampleItems' seen-continue and break arms.
    const openItems: PmItem[] = Array.from({ length: 5 }, (_, i) => ({
      id: i % 2 === 0 ? "dup" : `open-${i}`,
      title: "Open work",
      status: "open",
      updated_at: `2026-0${i + 1}-01T00:00:00Z`,
    }));
    const report = explainChangelogSelection({ items: openItems });
    ok(report.sample_items.status.length <= 3);
    equal(new Set(report.sample_items.status).size, report.sample_items.status.length, "samples are de-duplicated");
  });

  it("explains inferred attribution with undated and duplicate-label items", () => {
    // Two fully-undated items (no completion timestamps) are inferred with
    // undefined timestamps, exercising buildAttributionProvenance's `?? ""`
    // sort arm on both sides of the comparator; duplicate id+title labels
    // exercise the seen-continue arm.
    const undatedA: PmItem = { id: "u1", title: "Undated work", status: "closed" };
    const undatedB: PmItem = { id: "u2", title: "Undated work", status: "closed" };
    const dupA: PmItem = { id: "dup", title: "Dup", status: "closed", updated_at: "2026-07-01T00:00:00Z" };
    const dupB: PmItem = { id: "dup", title: "Dup", status: "closed", updated_at: "2026-08-01T00:00:00Z" };
    const report = explainChangelogSelection({
      items: [undatedA, undatedB, dupA, dupB, item({ id: "x", title: "X", updated_at: "2026-06-01T00:00:00Z" })],
      version: "1.2.0",
    });
    ok(report.attribution_provenance !== undefined);
    ok((report.attribution_provenance?.inferred ?? 0) >= 3);
    // The inferred sample is de-duplicated by label.
    equal(new Set(report.attribution_provenance?.inferred_sample).size, report.attribution_provenance?.inferred_sample.length);
  });
});

describe("generator: version comparators directly", () => {
  it("compareVersionHeadings pins the fallback first in both directions", () => {
    equal(compareVersionHeadings("1.2.0", "1.2.0", "Unreleased"), 0);
    equal(compareVersionHeadings("Unreleased", "1.2.0", "Unreleased"), -1);
    equal(compareVersionHeadings("1.2.0", "Unreleased", "Unreleased"), 1);
    equal(compareVersionHeadings("1.2.0", "1.1.0", "Unreleased"), -1);
  });

  it("compareVersionStrings handles missing segments and lexical tie-breaks", () => {
    // Different segment counts exercise the `?? ""` arms on both sides.
    ok(compareVersionStrings("1.0", "1.0.0") < 0);
    ok(compareVersionStrings("1.0.0", "1.0") > 0);
    // Lexical tie-break for non-numeric segments (prerelease suffixes).
    ok(compareVersionStrings("1.0.0-rc.1", "1.0.0-rc.2") < 0);
    equal(compareVersionStrings("1.0.0", "1.0.0"), 0);
  });
});

describe("generator: remaining edges", () => {
  it("suggests a patch bump with an `other change` reason for uncategorised work", () => {
    const suggestion = suggestSemver({
      items: [{ id: "a", title: "Tidy the docs layout", status: "closed", updated_at: "2026-06-01T00:00:00Z" }],
    });
    equal(suggestion.bump, "patch");
    match(suggestion.reason, /other change/);
    const plural = suggestSemver({
      items: [
        { id: "a", title: "Tidy the docs layout", status: "closed", updated_at: "2026-06-01T00:00:00Z" },
        { id: "b", title: "Polish the usage guide", status: "closed", updated_at: "2026-06-02T00:00:00Z" },
      ],
    });
    equal(plural.reason, "2 other changes");
  });

  it("detects breaking from a string `true` flag", () => {
    const suggestion = suggestSemver({
      items: [{ id: "a", title: "Rewrite", status: "closed", breaking: "true", updated_at: "2026-06-01T00:00:00Z" }],
    });
    equal(suggestion.bump, "major");
  });

  it("explainChangelogSelection accepts all statuses under an empty includeStatuses list", () => {
    const report = explainChangelogSelection({
      items: [{ id: "a", title: "Open", status: "open", updated_at: "2026-06-01T00:00:00Z" }],
      includeStatuses: [],
    });
    equal(report.stage_counts.visible_items, 1);
  });

  it("explainChangelogSelection excludes a status-less item against a non-empty status set", () => {
    // An item with no status hits the `item.status ?? ""` arm of the status
    // filter against a non-empty set and is excluded.
    const report = explainChangelogSelection({
      items: [{ id: "a", title: "No status", updated_at: "2026-06-01T00:00:00Z" }],
      includeStatuses: ["closed"],
    });
    equal(report.excluded_counts.status, 1);
  });

  it("explainChangelogSelection reports net time-window exclusions under --respect-item-release", () => {
    // A declared item closed outside the window is re-admitted by attribution
    // (so it is removed from the net time-window exclusions), while an item with
    // no release that falls outside the window stays excluded — exercising both
    // arms of the excludedByTimeNet filter callback.
    const report = explainChangelogSelection({
      items: [
        item({ id: "a", title: "In window", release: "1.2.0", updated_at: "2026-05-15T00:00:00Z" }),
        item({ id: "b", title: "Late close", release: "1.2.0", updated_at: "2026-07-01T00:00:00Z" }),
        item({ id: "c", title: "Undated out", updated_at: "2026-07-01T00:00:00Z" }),
      ],
      version: "1.2.0",
      since: "2026-05-01T00:00:00Z",
      until: "2026-06-01T00:00:00Z",
      respectItemRelease: true,
    });
    ok(report.stage_counts.after_item_release !== undefined);
    ok(report.excluded_counts.time_window >= 1);
  });

  it("explainChangelogSelection keeps empty sections under includeEmpty", () => {
    const windows: ChangelogReleaseWindow[] = [
      { heading: "1.0.0 - 2026-01-01", releaseTag: "v1.0.0", until: "2026-01-02T00:00:00Z" },
      { heading: "1.1.0 - 2026-02-01", releaseTag: "v1.1.0", since: "2026-01-02T00:00:00Z", sinceExclusive: true, until: "2026-03-01T00:00:00Z" },
    ];
    const report = explainChangelogSelection({
      items: [item({ id: "a", title: "In 1.1", updated_at: "2026-02-10T00:00:00Z" })],
      releaseWindows: windows,
      includeEmpty: true,
    });
    ok(report.stage_counts.candidate_sections >= 2);
  });

  it("renders a toon link for a non-story item type and an unset type", () => {
    // itemTypeToDir's default `?? ${t}s` arm for a non-irregular type, and the
    // `type ?? "issue"` arm for an item with no type at all.
    const withType = createChangelog({
      items: [item({ id: "pm-1", title: "Feature work", type: "feature", updated_at: "2026-06-01T00:00:00Z" })],
      itemRefStyle: "toon",
      itemUrlBase: "https://example.com/blob",
    });
    match(withType.markdown, /\/features\/pm-1\.toon\)/);
    const noType = createChangelog({
      items: [{ id: "pm-2", title: "Untyped work", status: "closed", updated_at: "2026-06-01T00:00:00Z" }],
      itemRefStyle: "toon",
      itemUrlBase: "https://example.com/blob",
    });
    match(noType.markdown, /\/issues\/pm-2\.toon\)/);
  });

  it("omits a link for an item with no url under includeLinks", () => {
    const result = createChangelog({
      items: [
        item({ id: "a", title: "No url", updated_at: "2026-06-01T00:00:00Z" }),
        item({ id: "b", title: "Has url", url: "https://example.com", updated_at: "2026-06-01T00:00:00Z" }),
      ],
      includeLinks: true,
    });
    match(result.markdown, /\[link\]\(https:\/\/example\.com\/?\)/);
    ok(!/No url \(a\)[^\n]*\[link\]/.test(result.markdown), "an item with no url has no link suffix");
  });

  it("orders two timestamp-less items stably", () => {
    // Two items carrying no completion timestamps at all exercise compareItems'
    // `itemTimestamp(a) ?? ""` and `(b) ?? ""` arms on both sides; an empty
    // includeStatuses list admits them and an unbounded window keeps them.
    const result = createChangelog({
      items: [
        { id: "a", title: "Undated one", status: "closed" },
        { id: "b", title: "Undated two", status: "closed" },
      ],
      includeStatuses: [],
    });
    ok(result.markdown.includes("Undated one"));
    ok(result.markdown.includes("Undated two"));
  });

  it("inserts an Unreleased section before a real version heading", () => {
    // Existing has a `## [1.0.0](url) - date` heading (bracketed) and a generated
    // Unreleased section; the bracketed arm of normalizeReleaseHeadingKey and
    // the newKey === UNRELEASED insertBefore arm both fire.
    const generated = createChangelog({ items: [item({ id: "new", title: "Pending work", updated_at: "2026-06-01T00:00:00Z" })] });
    const existing = "# Changelog\n\n## [1.0.0](https://example.com) - 2026-01-01\n\n- Old\n";
    const merged = mergeChangelog(existing, generated.markdown, { title: "Changelog" });
    const unreleasedIdx = merged.markdown.indexOf("## Unreleased");
    const v100Idx = merged.markdown.indexOf("## [1.0.0]");
    ok(unreleasedIdx !== -1 && v100Idx !== -1 && unreleasedIdx < v100Idx, "Unreleased inserted before the bracketed version");
  });

  it("insertAfterTitle emits the section after a title-only file", () => {
    // Existing is just `# Changelog` (no releases, no prose), so
    // insertReleaseSection routes to insertAfterTitle and the `!after` branch.
    const generated = createChangelog({ items: [item({ id: "a", title: "New work", updated_at: "2026-06-01T00:00:00Z" })], version: "1.2.0", date: "2026-06-01" });
    const merged = mergeChangelog("# Changelog\n", generated.markdown, { title: "Changelog" });
    match(merged.markdown, /# Changelog\n\n## 1\.2\.0/);
  });
});

describe("generator: generateChangelog wrapper", () => {
  it("returns the markdown string directly", () => {
    const md = generateChangelog({ items: [item({ id: "a", title: "Wrap test", updated_at: "2026-06-01T00:00:00Z" })] });
    equal(typeof md, "string");
    match(md, /- Wrap test \(a\)/);
  });
});
