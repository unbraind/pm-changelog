import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readSettings, serializeItemDocument, SETTINGS_DEFAULTS } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";

import { createChangelog, explainChangelogSelection } from "../src/generator.ts";
import { cliTestSurface } from "../src/cli.ts";
import extension from "../src/extension.ts";
import { parseReleaseItemStatuses, resolveGitReleaseMembership } from "../src/release-membership.ts";
import { resolveReleaseTagWindows } from "../src/release-context.ts";
import type { PmItem } from "../src/types.ts";

/** Run Git against the isolated fixture, retaining deterministic commit dates. */
function git(root: string, args: string[], date = "2026-09-10T04:00:00Z"): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Persist one fixture item through the SDK's canonical TOON serializer. */
function writeItem(root: string, status: "open" | "closed", format: "toon" | "json_markdown" = "toon"): void {
  writeFileSync(join(root, `.agents/pm/tasks/pm-test.${format === "toon" ? "toon" : "md"}`), serializeItemDocument({
    metadata: {
      id: "pm-test", title: "Ship branch work", description: "Release fixture", type: "Task", status,
      priority: 2, tags: [], author: "Test",
      created_at: "2026-09-10T04:00:00Z", updated_at: "2026-09-10T05:00:00Z",
      ...(status === "closed" ? { completed_at: "2026-09-10T05:00:00Z" } : {}),
    },
    body: "",
  }, { format }));
}

/** Create a clean real Git fixture with a valid tracker and one open item. */
function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "pm-changelog-membership-"));
  mkdirSync(join(root, ".agents/pm/tasks"), { recursive: true });
  writeFileSync(join(root, ".agents/pm/settings.json"), JSON.stringify(SETTINGS_DEFAULTS));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  writeItem(root, "open");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Initial work"]);
  return root;
}

test("a completion predating an unrelated tag is released only by the first containing tag", async () => {
  const root = createRepository();
  try {
    git(root, ["checkout", "-b", "feature"]);
    writeItem(root, "closed");
    git(root, ["commit", "-am", "Complete work"], "2026-09-10T05:00:00Z");
    git(root, ["checkout", "main"]);
    git(root, ["commit", "--allow-empty", "-m", "Unrelated release"], "2026-09-10T07:00:00Z");
    git(root, ["tag", "v2026.9.10"]);
    git(root, ["checkout", "feature"]);
    git(root, ["merge", "main", "--no-edit"], "2026-09-10T08:00:00Z");

    const items: PmItem[] = [{
      id: "pm-test", title: "Ship branch work", type: "Task", status: "closed",
      completed_at: "2026-09-10T05:00:00Z",
    }];
    const options = { items, releaseWindows: resolveReleaseTagWindows({ cwd: root }) };
    const releaseMembership = await resolveGitReleaseMembership(options, join(root, ".agents/pm"));
    deepEqual([...releaseMembership], [["pm-test", "Unreleased"]]);
    equal(createChangelog({ ...options, releaseMembership }).sections[0]!.items.length, 1);
    equal(explainChangelogSelection({ ...options, releaseMembership }).attribution_provenance?.release_membership, 1);

    git(root, ["checkout", "main"]);
    git(root, ["merge", "feature", "--no-edit"], "2026-09-10T09:00:00Z");
    git(root, ["commit", "--allow-empty", "-m", "Containing release"], "2026-09-11T07:00:00Z");
    git(root, ["tag", "v2026.9.11"]);
    git(root, ["commit", "--allow-empty", "-m", "Later release"], "2026-09-12T07:00:00Z");
    git(root, ["tag", "v2026.9.12"]);
    const laterOptions = { items, releaseWindows: resolveReleaseTagWindows({ cwd: root }) };
    const laterMembership = await resolveGitReleaseMembership(laterOptions, join(root, ".agents/pm"));
    deepEqual([...laterMembership], [["pm-test", "2026.9.11 - 2026-09-11"]]);
    const generated = createChangelog({ ...laterOptions, releaseMembership: laterMembership });
    equal(generated.itemCount, 1);
    equal(generated.sections.find((section) => section.items.length === 1)!.heading, "2026.9.11 - 2026-09-11");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("membership preserves declarations and explicit omission and pending-window intent", async (t) => {
  const root = createRepository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["commit", "--allow-empty", "-m", "Release"], "2026-09-10T07:00:00Z");
  git(root, ["tag", "v2026.9.10"]);
  const pmRoot = join(root, ".agents/pm");
  const item: PmItem = { id: "pm-test", title: "Closed work", status: "closed", completed_at: "2026-09-10T05:00:00Z" };
  const releaseWindows = resolveReleaseTagWindows({ cwd: root });
  const options = { items: [item], releaseWindows };
  for (const declared of [{ ...item, release: "2026.9.10" }, { ...item, metadata: { release: "2026.9.10" } }]) {
    equal((await resolveGitReleaseMembership({ ...options, items: [declared] }, pmRoot)).size, 0);
    equal(createChangelog({ ...options, items: [declared], releaseMembership: new Map([["pm-test", null]]) }).itemCount, 1);
  }
  equal((await resolveGitReleaseMembership({ items: [item] }, pmRoot)).size, 0);
  equal((await resolveGitReleaseMembership(options, join(root, "missing"))).size, 0);
  equal((await resolveGitReleaseMembership({ ...options, items: [{ ...item, id: undefined }] }, pmRoot)).size, 0);
  const withoutPending = { ...options, releaseWindows: releaseWindows.slice(1) };
  const omitted = await resolveGitReleaseMembership(withoutPending, pmRoot);
  deepEqual([...omitted], [["pm-test", null]]);
  equal(createChangelog({ ...withoutPending, releaseMembership: omitted }).itemCount, 0);
  const pending = {
    ...options,
    releaseWindows: [{ heading: "2026.9.11", releaseTag: "v2026.9.11" }, ...releaseWindows.slice(1)],
  };
  deepEqual([...(await resolveGitReleaseMembership(pending, pmRoot))], [["pm-test", "2026.9.11"]]);
  deepEqual([...(await resolveGitReleaseMembership({ ...options, items: [{ ...item, status: undefined }], includeStatuses: [] }, pmRoot))], [["pm-test", "Unreleased"]]);
  throws(() => createChangelog({ ...options, releaseMembership: new Map([["pm-test", "missing"]]) }), /Unknown release membership window/);
  equal(explainChangelogSelection({ items: [item], releaseMembership: new Map([["pm-test", "Unreleased"]]) }).attribution_provenance?.authoritative, 1);
  writeItem(root, "closed");
  const output = join(root, "CHANGELOG.md");
  await cliTestSurface.main(["--all-release-tags", "--pm-cwd", root, "--pm-root", pmRoot, "--output", output, "--explain"]);
  equal(readFileSync(output, "utf8").split("\n")[2], "## Unreleased");
});

test("membership reads Markdown blobs, ignores nested package documents, and handles untracked items", async (t) => {
  const root = createRepository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  rmSync(join(root, ".agents/pm/tasks/pm-test.toon"));
  writeItem(root, "closed", "json_markdown");
  writeFileSync(join(root, ".agents/pm/settings.json"), JSON.stringify({ ...SETTINGS_DEFAULTS, item_format: "json_markdown" }));
  mkdirSync(join(root, ".agents/pm/extensions/example/tasks"), { recursive: true });
  writeFileSync(join(root, ".agents/pm/extensions/example/tasks/pm-test.toon"), "not a tracker item");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Release Markdown item"], "2026-09-10T07:00:00Z");
  git(root, ["tag", "v2026.9.10"]);
  const item: PmItem = { id: "pm-test", title: "Closed work", status: "closed", completed_at: "2026-09-10T05:00:00Z" };
  const options = { items: [item], releaseWindows: resolveReleaseTagWindows({ cwd: root }) };
  equal((await resolveGitReleaseMembership(options, join(root, ".agents/pm"))).size, 0);
  deepEqual([...(await resolveGitReleaseMembership({ ...options, items: [{ ...item, id: "pm-untracked" }] }, join(root, ".agents/pm")))], [["pm-untracked", "Unreleased"]]);

  mkdirSync(join(root, ".agents/pm/issues"));
  writeFileSync(join(root, ".agents/pm/issues/pm-test.md"), readFileSync(join(root, ".agents/pm/tasks/pm-test.md")));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Duplicate item corruption"], "2026-09-11T07:00:00Z");
  git(root, ["tag", "v2026.9.11"]);
  await rejects(resolveGitReleaseMembership({ ...options, releaseWindows: [{ heading: "corrupt", releaseTag: "v2026.9.11", until: "2026-09-11T07:00:00Z" }] }, join(root, ".agents/pm")), /duplicate item/);

  const activation = await activateExtensionForTest(extension, {
    name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"],
  });
  await rejects(runRegisteredCommandForTest(activation.commands, {
    command: "changelog generate", pmRoot: join(root, ".agents/pm"),
    options: { "all-release-tags": true, "release-tag-pattern": "v2026.9.11", stdout: true, status: "closed" },
  }), /Cannot verify release membership/);
});

test("tags without tracker documents retain historical timestamp placement", async (t) => {
  const root = createRepository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["rm", ".agents/pm/tasks/pm-test.toon"]);
  git(root, ["commit", "-m", "Pre-tracker release"], "2026-09-10T07:00:00Z");
  git(root, ["tag", "v2026.9.10"]);
  const options = {
    items: [{ id: "pm-test", title: "Historical work", status: "closed", completed_at: "2026-09-10T05:00:00Z" }],
    releaseWindows: resolveReleaseTagWindows({ cwd: root }),
  };
  equal((await resolveGitReleaseMembership(options, join(root, ".agents/pm"))).size, 0);
});

test("Git links cannot masquerade as release item documents", async (t) => {
  const root = createRepository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${head},.agents/pm/tasks/pm-link.toon`]);
  git(root, ["commit", "-m", "Git link"], "2026-09-10T07:00:00Z");
  git(root, ["tag", "v2026.9.10"]);
  await rejects(resolveGitReleaseMembership({
    items: [{ id: "pm-link", title: "Invalid item path", status: "closed", completed_at: "2026-09-10T05:00:00Z" }],
    releaseWindows: resolveReleaseTagWindows({ cwd: root }),
  }, join(root, ".agents/pm")), /not a Git blob/);
});

test("Git batch decoding rejects truncated, mismatched, and ambiguous evidence", async (t) => {
  const root = createRepository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { schema } = await readSettings(join(root, ".agents/pm"));
  const content = readFileSync(join(root, ".agents/pm/tasks/pm-test.toon"));
  const hash = "a".repeat(40);
  const blobs = new Map([["pm-test", { hash, format: "toon" as const }]]);
  const valid = Buffer.concat([Buffer.from(`${hash} blob ${content.length}\n`), content, Buffer.from("\n")]);
  deepEqual([...parseReleaseItemStatuses(valid, blobs, schema)], [["pm-test", "open"]]);
  for (const malformed of [
    Buffer.from(hash), Buffer.from(`wrong blob 1\nx\n`), Buffer.from(`${hash} tree 1\nx\n`),
    Buffer.from(`${hash} blob NaN\nx\n`), Buffer.from(`${hash} blob -1\nx\n`),
    Buffer.from(`${hash} blob 999\nx\n`), Buffer.from(`${hash} blob 1\nx!`),
    Buffer.concat([valid, Buffer.from("extra")]),
  ]) {
    throws(() => parseReleaseItemStatuses(malformed, blobs, schema), /Git blob/);
  }
  throws(() => parseReleaseItemStatuses(valid, new Map([["pm-other", { hash, format: "toon" }]]), schema), /identity disagree/);
});

test("repository-root and symlinked trackers retain correct Git path membership", async (t) => {
  const root = createRepository();
  const aliasRoot = mkdtempSync(join(tmpdir(), "pm-changelog-root-alias-"));
  t.after(() => { rmSync(aliasRoot, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });
  renameSync(join(root, ".agents/pm/tasks"), join(root, "tasks"));
  renameSync(join(root, ".agents/pm/settings.json"), join(root, "settings.json"));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Root tracker"], "2026-09-10T07:00:00Z");
  git(root, ["tag", "v2026.9.10"]);
  symlinkSync(root, join(aliasRoot, "workspace"), "dir");
  const options = {
    items: [{ id: "pm-test", title: "Branch completion", status: "closed", completed_at: "2026-09-10T05:00:00Z" }],
    releaseWindows: resolveReleaseTagWindows({ cwd: root }),
  };
  for (const pmRoot of [root, join(aliasRoot, "workspace")]) {
    deepEqual([...(await resolveGitReleaseMembership(options, pmRoot))], [["pm-test", "Unreleased"]]);
  }
});

test("historical inline and file-backed schemas survive current schema evolution", async (t) => {
  const root = createRepository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents/pm");
  const historicalSchema = { ...SETTINGS_DEFAULTS.schema, statuses: [...SETTINGS_DEFAULTS.schema.statuses, { id: "reviewed", roles: ["active" as const] }] };
  const document = {
    metadata: {
      id: "pm-test", title: "Historical custom status", description: "Schema evolution fixture", type: "LegacyTask", status: "reviewed",
      priority: 2 as const, tags: [], created_at: "2026-09-10T04:00:00Z", updated_at: "2026-09-10T05:00:00Z",
      legacy_field: "previously allowed",
    }, body: "",
  };
  writeFileSync(join(pmRoot, "settings.json"), JSON.stringify({ ...SETTINGS_DEFAULTS, schema: historicalSchema }));
  writeFileSync(join(pmRoot, "tasks/pm-test.toon"), serializeItemDocument(document, { schema: historicalSchema }));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Release inline schema"], "2026-09-10T07:00:00Z");
  git(root, ["tag", "v2026.9.10"]);

  mkdirSync(join(root, "schema"));
  writeFileSync(join(root, "schema/statuses.json"), JSON.stringify({ statuses: historicalSchema.statuses }));
  writeFileSync(join(pmRoot, "settings.json"), JSON.stringify({ ...SETTINGS_DEFAULTS, schema: { files: { statuses: "../../schema/statuses.json" } } }));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Release file-backed schema"], "2026-09-11T07:00:00Z");
  git(root, ["tag", "v2026.9.11"]);
  writeFileSync(join(pmRoot, "settings.json"), JSON.stringify({ ...SETTINGS_DEFAULTS, schema: { unknown_field_policy: "reject" } }));
  const options = {
    items: [{ id: "pm-test", title: "Current completion", status: "closed", completed_at: "2026-09-10T05:00:00Z" }],
    releaseWindows: resolveReleaseTagWindows({ cwd: root }),
  };
  deepEqual([...(await resolveGitReleaseMembership(options, pmRoot))], [["pm-test", "Unreleased"]]);
  writeFileSync(join(pmRoot, "settings.json"), JSON.stringify({ ...SETTINGS_DEFAULTS, schema: historicalSchema }));
  writeFileSync(join(pmRoot, "tasks/pm-test.toon"), serializeItemDocument({ ...document, metadata: { ...document.metadata, status: "closed" } }, { schema: historicalSchema }));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Release legacy field completion"], "2026-09-12T07:00:00Z");
  git(root, ["tag", "v2026.9.12"]);
  writeFileSync(join(pmRoot, "settings.json"), JSON.stringify({ ...SETTINGS_DEFAULTS, schema: { unknown_field_policy: "reject" } }));
  deepEqual([...(await resolveGitReleaseMembership({ ...options, releaseWindows: resolveReleaseTagWindows({ cwd: root }) }, pmRoot))], [["pm-test", "2026.9.12 - 2026-09-12"]]);
});

test("historical schema evidence fails closed for malformed documents and escaping paths", async (t) => {
  const root = createRepository();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pmRoot = join(root, ".agents/pm");
  const settingsPath = join(pmRoot, "settings.json");
  const samples = [
    "{", "null", "[]", "3", "{}",
    ...[null, [], 3, { files: [] }, { files: null }].map((schema) => JSON.stringify({ ...SETTINGS_DEFAULTS, schema })),
    ...[false, "", "/outside/schema.json", "../../..", "../../../escape.json"].map((statuses) =>
      JSON.stringify({ ...SETTINGS_DEFAULTS, schema: { files: { statuses } } })),
  ];
  for (const [index, content] of samples.entries()) {
    writeFileSync(settingsPath, content);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", `Malformed schema ${index}`]);
    const tag = `invalid-schema-${index}`;
    git(root, ["tag", tag]);
    await rejects(resolveGitReleaseMembership({
      items: [{ id: "pm-test", title: "Historical work", status: "closed", completed_at: "2026-09-10T03:00:00Z" }],
      releaseWindows: [{ heading: tag, releaseTag: tag, until: "2026-09-10T07:00:00Z" }],
    }, pmRoot), /JSON|tagged|Tagged/);
  }

  writeFileSync(settingsPath, JSON.stringify(SETTINGS_DEFAULTS));
  mkdirSync(join(pmRoot, "schema"), { recursive: true });
  writeFileSync(join(pmRoot, "schema/statuses.json"), "{malformed");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Malformed schema file"]);
  git(root, ["tag", "invalid-schema-file"]);
  await rejects(resolveGitReleaseMembership({
    items: [{ id: "pm-test", title: "Historical work", status: "closed", completed_at: "2026-09-10T03:00:00Z" }],
    releaseWindows: [{ heading: "bad-file", releaseTag: "invalid-schema-file", until: "2026-09-10T07:00:00Z" }],
  }, pmRoot), /Invalid tagged schema evidence/);

  git(root, ["rm", ".agents/pm/settings.json"]);
  git(root, ["commit", "-m", "Legacy tracker without tagged settings"]);
  git(root, ["tag", "no-settings"]);
  writeFileSync(settingsPath, JSON.stringify(SETTINGS_DEFAULTS));
  const options = {
    items: [{ id: "pm-test", title: "Historical work", status: "open", completed_at: "2026-09-10T03:00:00Z" }], includeStatuses: ["open"],
    releaseWindows: [{ heading: "legacy", releaseTag: "no-settings", until: "2026-09-10T07:00:00Z" }],
  };
  equal((await resolveGitReleaseMembership(options, pmRoot)).size, 0);
  rmSync(join(pmRoot, "schema"), { recursive: true });
  const { schema: unusedSchema, ...withoutSchema } = SETTINGS_DEFAULTS;
  writeFileSync(settingsPath, JSON.stringify(withoutSchema));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Default schema"]);
  git(root, ["tag", "default-schema"]);
  equal((await resolveGitReleaseMembership({ ...options, releaseWindows: [{ heading: "default", releaseTag: "default-schema", until: "2026-09-10T07:00:00Z" }] }, pmRoot)).size, 0);
});
