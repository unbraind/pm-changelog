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
  const match = new RegExp(
    `^[ \\t]*-[ \\t]+name:[ \\t]+${escapedName}[ \\t]*(?:#[^\\r\\n]*)?$`,
    "m"
  ).exec(workflow);
  assert.ok(match, `release workflow should contain the exact ${name} step`);
  return match.index;
}

test("daily release requests protected-PR permissions without a direct main push", () => {
  const releaseJob = workflow.slice(workflow.indexOf("jobs:\n  release:"), stepIndex("Checkout"));
  assert.match(releaseJob, /^ {6}pull-requests: write$/m);
  assert.doesNotMatch(workflow.slice(0, workflow.indexOf("jobs:")), /pull-requests: write/);
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
  assert.match(
    publishStep,
    /Refusing to downgrade supply-chain attestations[\s\S]*exit 1/
  );
  assert.match(
    workflow,
    /escaped_tag=.*sed 's\/\[\]\[\\\\\.\^\$\*\+\?\(\)\{\}\|\]\/\\\\&\/g'/
  );
});

test("npm publication authenticates by OIDC, with no stored token anywhere in the workflow", () => {
  // A stored npm token is what silently broke the whole fleet: it was rejected
  // from 2026-08-17 onward, every release job failed at the publish step with a
  // registry E404 on PUT, and main kept bumping the version regardless. Trusted
  // publishing removes the credential that can expire, so this test fails closed
  // if a token is ever reintroduced.
  const withoutComments = workflow.replace(/^[ \t]*#[^\r\n]*$/gm, "");

  assert.doesNotMatch(withoutComments, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(withoutComments, /NPM_TOKEN/);
  assert.doesNotMatch(withoutComments, /secrets\.NPM/);

  // OIDC is only reachable when the job may mint an id-token.
  assert.match(workflow, /^ {6}id-token: write$/m);
});

test("the npm used to publish is new enough to exchange an OIDC token", () => {
  // node 22 ships npm 10.x, which cannot do trusted publishing and would fall
  // back to token auth; 11.5.1 is the first release that can. The upgrade has to
  // happen before the publish step, or the job authenticates with nothing.
  const upgrade = stepIndex("Use an npm that supports trusted publishing");
  const publish = stepIndex("Publish npm package");

  assert.ok(upgrade < publish, "npm must be upgraded before the publish step runs");
  assert.match(workflow.slice(upgrade, publish), /npm install -g npm@\^11\.5\.1/);
});
