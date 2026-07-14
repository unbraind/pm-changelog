import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/release.yml"),
  "utf-8"
);

function stepIndex(name: string): number {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^ {6}- name: ${escapedName}$`, "m").exec(workflow);
  assert.ok(match, `release workflow should contain the exact ${name} step`);
  return match.index;
}

test("daily release requests protected-PR permissions without a direct main push", () => {
  assert.match(workflow, /^\s{2}pull-requests: write$/m);
  assert.doesNotMatch(workflow, /git push origin HEAD:main/);
  assert.match(workflow, /HEAD:refs\/heads\/\$\{release_branch\}/);
  assert.match(workflow, /--force-with-lease=/);
});

test("release metadata merges before npm publication and tagging", () => {
  const commit = stepIndex("Commit release files");
  const refCheck = stepIndex("Check release ref");
  const merge = stepIndex("Merge release metadata through protected PR");
  const verify = stepIndex("Verify merged release");
  const publish = stepIndex("Publish npm package");
  const tag = stepIndex("Push release tag");

  assert.ok(commit < refCheck);
  assert.ok(refCheck < merge);
  assert.ok(merge < verify);
  assert.ok(verify < publish);
  assert.ok(publish < tag);
});

test("release PR transaction is exact-SHA guarded and retryable", () => {
  assert.match(workflow, /release_branch="release\/\$\{RELEASE_TAG#v\}"/);
  assert.match(workflow, /gh pr list/);
  assert.match(workflow, /gh pr create/);
  assert.match(workflow, /pulls\/\$\{pr_number\}\/merge/);
  assert.match(workflow, /-f sha="\$release_commit"/);
  assert.match(workflow, /current_main_sha.*RELEASE_BASE_SHA/s);
  assert.match(workflow, /release_commit.*current_main_sha/s);
  assert.match(
    workflow,
    /release_commit" == "\$current_main_sha[\s\S]*git push origin --delete "\$release_branch"[\s\S]*exit 0/
  );
});

test("interrupted releases resume their version and missing GitHub releases recover", () => {
  const decideStart = stepIndex("Decide release");
  const updateStart = stepIndex("Update release version");
  const decideStep = workflow.slice(decideStart, updateStart);
  const githubReleaseStart = stepIndex("Create GitHub release");
  const githubReleaseStep = workflow.slice(githubReleaseStart);

  assert.match(decideStep, /current_version/);
  assert.match(decideStep, /current_padded_tag/);
  assert.match(decideStep, /Resuming untagged release metadata/);
  assert.match(decideStep, /should_recover_release=true/);
  assert.match(
    githubReleaseStep,
    /should_release == 'true' \|\| steps\.decide\.outputs\.should_recover_release == 'true'/
  );
  assert.match(githubReleaseStep, /npm view "\$\{pkg_name\}@\$\{NPM_VERSION\}"/);
  assert.match(githubReleaseStep, /GitHub release \$\{RELEASE_TAG\} already exists/);
});

test("published bytes come from the exact merged and fully checked main commit", () => {
  const verifyStart = stepIndex("Verify merged release");
  const publishStart = stepIndex("Publish npm package");
  const verifyStep = workflow.slice(verifyStart, publishStart);

  assert.match(verifyStep, /actual_sha.*MERGED_SHA/s);
  assert.match(verifyStep, /actual_version.*NPM_VERSION/s);
  assert.match(verifyStep, /npm run release:check/);
  assert.match(verifyStep, /git diff --exit-code/);
});

test("npm publication never downgrades provenance", () => {
  const publishStart = stepIndex("Publish npm package");
  const tagStart = stepIndex("Push release tag");
  const publishStep = workflow.slice(publishStart, tagStart);

  assert.match(publishStep, /npm publish --access public --provenance --ignore-scripts/);
  assert.doesNotMatch(publishStep, /publish_without_provenance/);
  assert.match(publishStep, /Refusing to downgrade supply-chain attestations/);
});
