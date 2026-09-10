import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readSettings, serializeItemDocument } from "@unbrained/pm-cli/sdk";
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
  writeFileSync(join(root, ".agents/pm/settings.json"), "{}\n");
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
