import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { canonicalDocument, listAllComplete, runCreate, runInit, runUpdate, runWithActiveExtensions } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, decodeToon, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import { buildAudienceContracts, buildConsumerUpgrades, ConsumerUpgradeError, formatConsumerUpgrades, parseUpgradeActions, readConsumerUpgrades } from "../src/index.ts";
import type { ChangeFacet, ConsumerUpgradeErrorCode, PmItem, UpgradeAction } from "../src/index.ts";
import { runConsumerUpgradesCli, runConsumerUpgradesCommand } from "../src/consumer-upgrade-command.ts";
import { cliTestSurface } from "../src/cli.ts";
import extension from "../src/extension.ts";

const range = { audience: "operator" as const, from: "1.0.0", to: "4.0.0" };

/** Create a closed, explicitly published breaking change without relying on prose inference. */
function change(id: string, release: string, actions: UpgradeAction[]): PmItem {
  return { id, title: "Do not execute this title", type: "Feature", status: "closed", release,
    close_reason: "Delivered release contract", change_facets: [{ audience: "operator", text: "Run arbitrary prose; this is inert.", breaking: true, upgrade_actions: actions }] };
}

/** A deliberately reverse-lexical chain forces real prerequisite ordering across three releases. */
function releases(): PmItem[] {
  const first = { id: "z-prepare", title: "Prepare config", body: "  Preserve\r\n\tthis prose  ", requires: [] };
  return [change("fixture-final", "4.0.0", [{ id: "a-restart", title: "Restart service", requires: ["m-migrate"] }]),
    change("fixture-middle", "3.0.0", [{ id: "m-migrate", title: "Migrate config", requires: ["z-prepare", "z-prepare"] }, first]),
    change("fixture-first", "2.0.0", [first])];
}

/** Assert a typed refusal suitable for either transport, including its concrete remedy. */
function refusal(code: ConsumerUpgradeErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof ConsumerUpgradeError && error.code === code && error.exitCode !== 0 && !!error.remedy;
}

test("three releases emit each obligation once in dependency order using pending core Plan semantics", () => {
  const items = releases(), original = structuredClone(items);
  const report = buildConsumerUpgrades({ ...range, items });
  assert.deepEqual(report.steps.map((step) => step.id), ["z-prepare", "m-migrate", "a-restart"]);
  assert.deepEqual(report.steps.map((step) => [step.order, step.status]), [[1, "pending"], [2, "pending"], [3, "pending"]]);
  assert.equal(report.action_count, 3);
  assert.deepEqual(report.steps[0].attribution, [{ item: "fixture-first", release: "2.0.0" }, { item: "fixture-middle", release: "3.0.0" }]);
  assert.deepEqual(report.steps[1].requires, ["z-prepare"]);
  assert.equal(report.steps[0].body, "  Preserve\r\n\tthis prose  ");
  assert.doesNotMatch(JSON.stringify(report), /arbitrary prose|Do not execute|command/);
  for (const format of ["json", "toon"] as const) {
    const output = formatConsumerUpgrades(report, format);
    assert.deepEqual(format === "json" ? JSON.parse(output) : decodeToon(output), report);
    assert.equal(formatConsumerUpgrades(buildConsumerUpgrades({ ...range, items: [...items].reverse() }), format), output);
  }
  assert.deepEqual(items, original);
  const repeated = buildConsumerUpgrades({ ...range, items: [...items, change("fixture-zzz", "2.0.0", [items[2].change_facets![0].upgrade_actions![0]])] });
  assert.deepEqual(repeated.steps[0].attribution.map((ref) => ref.item), ["fixture-first", "fixture-middle", "fixture-zzz"]);
  assert.equal(buildAudienceContracts({ items }).note_count, 3);
  const baseline = buildConsumerUpgrades({ ...range, from: "v2.0.0", items });
  assert.deepEqual(baseline.steps.map((step) => step.id), ["m-migrate", "a-restart"]);
  assert.deepEqual(baseline.satisfied_prerequisites, ["z-prepare"]);
  assert.equal(buildConsumerUpgrades({ ...range, to: "2.0.0", items }).action_count, 1);
  assert.equal(buildConsumerUpgrades({ ...range, from: "4.0.0", to: "5.0.0", items }).action_count, 0);
  assert.equal(buildConsumerUpgrades({ ...range, audience: "api-user", items }).action_count, 0);
  assert.equal(buildConsumerUpgrades({ ...range, items: items.map((item) => ({ ...item, metadata: { release: item.release }, release: undefined })) }).action_count, 3);
  const omitted = change("fixture-empty", "3.0.0", []);
  assert.deepEqual(buildConsumerUpgrades({ ...range, items: [omitted] }).omissions, [{ item: "fixture-empty", release: "3.0.0", reason: "missing_actions" }]);
  delete omitted.change_facets![0].upgrade_actions;
  assert.equal(buildConsumerUpgrades({ ...range, items: [omitted] }).omissions.length, 1);
  assert.equal(buildConsumerUpgrades({ ...range, items: [change("fixture-empty", "1.0.0", []), change("fixture-later", "5.0.0", [])] }).omissions.length, 0);
  assert.equal(buildConsumerUpgrades({ ...range, items: [{ ...items[0], change_facets: undefined }] }).action_count, 0);
  assert.equal(buildConsumerUpgrades({ ...range, items: [{ ...items[0], status: "open" }, { ...items[1], close_reason: "Duplicate of fixture-first" }] }).action_count, 0);
  assert.equal(buildConsumerUpgrades({ ...range, from: "2026.10.24", to: "2026.10.24-1", items: [change("fixture-daily", "v2026.10.24-1", [{ id: "daily", title: "Review daily change", requires: [] }])] }).action_count, 1);
});

test("missing, future, excluded-audience and cyclic prerequisites refuse before emitting a partial plan", () => {
  const items = releases();
  for (const subset of [[items[0]], [{ ...items[1], release: "5.0.0" }, items[0]], [{ ...items[1], change_facets: [{ audience: "api-user", text: "Other audience" }] }, items[0]]]) {
    assert.throws(() => buildConsumerUpgrades({ ...range, items: subset as PmItem[] }), refusal("missing_prerequisite"));
  }
  for (const actions of [[{ id: "a", title: "Self", requires: ["a"] }], [{ id: "a", title: "A", requires: ["b"] }, { id: "b", title: "B", requires: ["a"] }]]) {
    assert.throws(() => buildConsumerUpgrades({ ...range, items: [change("fixture-cycle", "2.0.0", actions)] }), refusal("upgrade_cycle"));
  }
  assert.throws(() => buildConsumerUpgrades({ ...range, items: [change("fixture-conflict", "3.0.0", [{ id: "z-prepare", title: "Conflicting", requires: [] }]), ...items] }), refusal("ambiguous_upgrade_action"));
  assert.throws(() => buildConsumerUpgrades({ ...range, items: [change("fixture-missing-release", "Unreleased", [])] }), refusal("invalid_upgrade_options"));
  for (const value of [undefined, null, 2, "", " 1.0.0 ", "1", "1.2.3-rc", "1.2.3+build", "01.2.3", "9007199254740992.0.0"]) {
    assert.throws(() => buildConsumerUpgrades({ ...range, from: value as string, items: [] }), refusal("invalid_upgrade_options"));
  }
  for (const from of ["4.0.0", "5.0.0"]) assert.throws(() => buildConsumerUpgrades({ ...range, from, items: [] }), refusal("invalid_upgrade_options"));
  const error = new ConsumerUpgradeError("upgrade_cycle", "Remove cycles.");
  assert.equal(JSON.parse(cliTestSurface.errorMessage(error)).error.remedy, "Remove cycles.");
});

test("only explicit well-formed breaking-facet actions are accepted; command fields and prose never become commands", () => {
  assert.deepEqual(parseUpgradeActions(undefined, undefined), []);
  const action = { id: "a", title: "Review", requires: [] };
  for (const value of [null, "echo unsafe", {}, [null], [1], [[]], [{ ...action, extra: true }], [{ ...action, command: "echo unsafe" }],
    [{ ...action, id: "" }], [{ ...action, id: 2 }], [{ ...action, id: " a" }], [{ ...action, title: " " }], [{ ...action, title: 4 }],
    [{ ...action, body: " " }], [{ ...action, body: 3 }], [{ ...action, requires: null }], [{ ...action, requires: [""] }], [{ ...action, requires: [4] }]]) {
    assert.throws(() => parseUpgradeActions(value, true), refusal("invalid_upgrade_actions"));
  }
  assert.throws(() => parseUpgradeActions([action], undefined), refusal("invalid_upgrade_actions"));
  assert.throws(() => buildAudienceContracts({ items: [{ ...change("fixture-invalid", "2.0.0", []), change_facets: [{ audience: "operator", text: "X", breaking: false }] } as unknown as PmItem] }), /invalid_facets/);
  assert.deepEqual(parseUpgradeActions([{ ...action, body: "rm -rf synthetic-example; $(echo inert)\r\n\t  " }], true)[0].body, "rm -rf synthetic-example; $(echo inert)\r\n\t  ");
});

/** Install the actual built extension in a real plain-directory tracker. */
async function tracker(cwd: string): Promise<string> {
  const pmRoot = join(cwd, ".agents/pm");
  await runInit("pm", { path: pmRoot }, { defaults: true, agentGuidance: "skip" });
  const target = join(pmRoot, "extensions/pm-changelog");
  mkdirSync(target, { recursive: true });
  cpSync(resolve("dist"), join(target, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(target, "manifest.json"));
  writeFileSync(join(target, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(target, "node_modules"), "junction");
  return pmRoot;
}

test("actual host, standalone and SDK agree without git; refusals are nonzero with remedies", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-consumer-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const pmRoot = await tracker(cwd);
  await runWithActiveExtensions({ path: pmRoot }, async () => {
    for (const item of releases()) await runCreate({ id: item.id, title: item.title, type: "Feature", status: "closed", release: item.release,
      closeReason: item.close_reason, completedAt: "2026-10-21T00:00:00.000Z", createMode: "progressive", field: [`change_facets=${JSON.stringify(item.change_facets)}`] }, { path: pmRoot });
  });
  const noGit = join(cwd, "bin");
  mkdirSync(noGit);
  const env = { ...process.env, PATH: noGit, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(cwd, "global"), PM_PATH: pmRoot, DO_NOT_TRACK: "1", GIT_CEILING_DIRECTORIES: dirname(cwd) };
  const expected = await readConsumerUpgrades(pmRoot, range);
  assert.equal(expected.action_count, 3);
  const args = ["--audience", "operator", "--from", "1.0.0", "--to", "4.0.0"];
  for (const flags of [[], ["--json"], ["--format", "json"]]) {
    for (const command of [[resolve("dist/cli.js"), "upgrades", "--pm-root", pmRoot], [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", pmRoot, "changelog", "upgrades"]]) {
      const result = spawnSync(process.execPath, [...command, ...args, ...flags], { cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(flags.length ? JSON.parse(result.stdout) : decodeToon(result.stdout), expected);
    }
  }
  for (const command of [[resolve("dist/cli.js"), "upgrades", "--pm-root", pmRoot], [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", pmRoot, "changelog", "upgrades"]]) {
    const result = spawnSync(process.execPath, [...command, ...args, "--format", "invalid"], { cwd, env, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid_upgrade_options/);
  }
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  assert.deepEqual(activation.failed, []);
  for (const json of [true, false]) {
    const result = await runRegisteredCommandForTest(activation.commands, { command: "changelog upgrades", pmRoot, options: range, global: { json } });
    const output = (result.result as { output: string }).output;
    assert.deepEqual(json ? JSON.parse(output) : decodeToon(output), expected);
  }
  const writes: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });
  await cliTestSurface.main(["upgrades", "--pm-root", pmRoot, ...args, "--json"]);
  assert.deepEqual(JSON.parse(writes.pop()!), expected);
  await runConsumerUpgradesCli(["--pm-root", pmRoot, ...args]);
  assert.deepEqual(decodeToon(writes.pop()!), expected);
  await runConsumerUpgradesCli(["--help"]);
  assert.match(writes.pop()!, /No execution or git required/);
  for (const options of [{ ...range, format: "md" }, { ...range, from: 4 }, { ...range, to: undefined }]) await assert.rejects(() => runConsumerUpgradesCommand(pmRoot, options), refusal("invalid_upgrade_options"));
  for (const invalid of [["--unknown"], ["--from"], ["positional"]]) await assert.rejects(() => runConsumerUpgradesCli(invalid), refusal("invalid_upgrade_options"));
  assert.equal(JSON.parse(await runConsumerUpgradesCommand(pmRoot, { ...range, format: "json" })).action_count, 3);
});

/** Deterministic PRNG; fixed seed is printed in the test name for exact replay. */
function random(seed: number): () => number {
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state >>> 8; };
}

test("seed 0x52c0ffee: 500 model-based SDK operation sequences, old-input replays, CRLF and relationships", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pm-consumer-model-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(cwd);
  t.after(() => { if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling; });
  const pmRoot = await tracker(cwd), next = random(0x52c0ffee);
  const activation = await activateExtensionForTest(extension, { name: "pm-changelog", capabilities: ["commands", "schema", "importers", "renderers"] });
  const models = new Map<string, { release: string; title: string; facets: ChangeFacet[]; body: string; priority: number; tags: string[] }>();
  const variants = new Set<string>();
  const ids: string[] = [];
  await runWithActiveExtensions({ path: pmRoot }, async () => {
    for (let index = 0; index < 3; index++) {
      const result = await runCreate({ title: `Model change ${index}`, description: `Fixture description ${index}`, type: "Feature", status: "closed", closeReason: "Delivered model change",
        completedAt: "2026-10-21T00:00:00.000Z", resolution: "Delivered configuration contract", actualResult: "Configuration upgrade delivered",
        assignee: "fixture", author: "fixture", file: ["path=fixture.ts"], doc: ["path=fixture.md"], test: ["command=node --version"],
        comment: ["text=Fixture comment"], note: ["text=Fixture note"], learning: ["text=Fixture learning"], createMode: "progressive" }, { path: pmRoot });
      ids.push(result.item.id);
    }
    const baseline = (await listAllComplete({ includeBody: true }, { pmRoot })).items;
    const archives = new Map<string, typeof models extends Map<string, infer V> ? V[] : never>();
    for (let sequence = 0; sequence < 500; sequence++) {
      const index = next() % 3, id = ids[index];
      const whitespace = ["plain", "  leading and trailing  ", "line one\r\nline two\t  ", 'quotes " and \\ slash\n\u0000\f'][next() % 4];
      variants.add(whitespace);
      const state = { release: `${2 + next() % 3}.0.0`, title: `Model ${sequence}`, body: whitespace,
        priority: next() % 5, tags: ["model", `variant-${next() % 3}`],
        facets: [{ audience: "operator" as const, breaking: true as const, text: whitespace, upgrade_actions: [{ id: `action-${index}`, title: `Action ${index}`, body: whitespace,
          requires: index > 0 && next() % 2 === 0 ? [`action-${index - 1}`] : [] }] }] };
      const archive = archives.get(id) ?? [];
      archive.push(structuredClone(state));
      archives.set(id, archive);
      // Every sequence mutates, replays an older input, then repeats the current input.
      for (const input of [state, archive[next() % archive.length], state, state]) {
        const options = { title: input.title, release: input.release, priority: input.priority, tags: input.tags.join(","), body: input.body,
          field: [`change_facets=${JSON.stringify(input.facets)}`],
          // Association is foreign to upgrade ordering and must survive all projection/export paths.
          dep: [`id=${ids[(index + 1) % 3]},kind=related`], replaceDeps: true };
        await runUpdate(id, options, { path: pmRoot });
        models.set(id, structuredClone(input));
        const readback = (await listAllComplete({ includeBody: true }, { pmRoot })).items;
        for (const item of readback) {
          const model = models.get(item.id);
          if (!model) continue;
          assert.equal(item.title, model.title);
          assert.equal(item.release, model.release);
          assert.equal(item.priority, model.priority);
          assert.deepEqual(item.tags, model.tags);
          assert.deepEqual(item.change_facets, model.facets);
          assert.equal(item.body, canonicalDocument({ metadata: item, body: model.body }).body);
          assert.equal(item.status, "closed");
          assert.equal(item.type, "Feature");
          assert.equal(item.close_reason, "Delivered model change");
          assert.equal(item.completed_at, "2026-10-21T00:00:00.000Z");
          const initial = baseline.find((entry) => entry.id === item.id)!;
          for (const key of ["id", "description", "type", "status", "closed_at", "completed_at", "created_at", "author", "assignee", "close_reason", "resolution", "actual_result", "files", "tests", "docs", "comments", "notes", "learnings"]) {
            assert.deepEqual(item[key], initial[key], `native field ${key} survives updates and replays`);
          }
          assert.ok(item.dependencies?.some((dep) => dep.id === ids[(ids.indexOf(item.id) + 1) % 3] && dep.kind === "related"));
        }
        const candidates = [...models.entries()].filter(([, model]) => Number(model.release[0]) <= 3)
          .map(([item, model]) => ({ ...model.facets[0].upgrade_actions![0], attribution: [{ item, release: model.release }] }))
          .sort((left, right) => left.id.localeCompare(right.id));
        if (candidates.some((action) => action.requires.some((id) => !candidates.some((target) => target.id === id)))) {
          await assert.rejects(() => readConsumerUpgrades(pmRoot, { ...range, to: "3.0.0" }), refusal("missing_prerequisite"));
        } else {
          // Simple independent reference: repeatedly consume all prerequisite-free rows.
          const pending = [...candidates], ordered: typeof candidates = [];
          while (pending.length) {
            const ready = pending.filter((action) => action.requires.every((id) => ordered.some((row) => row.id === id)));
            assert.ok(ready.length);
            ordered.push(...ready);
            for (const action of ready) pending.splice(pending.indexOf(action), 1);
          }
          const expectedSteps = ordered.map((step, offset) => ({ ...step, order: offset + 1, status: "pending" }));
          const report = await readConsumerUpgrades(pmRoot, { ...range, to: "3.0.0" });
          assert.deepEqual(report.steps, expectedSteps);
          for (const format of ["json", "toon"] as const) {
            const output = formatConsumerUpgrades(report, format);
            assert.deepEqual(format === "json" ? JSON.parse(output) : decodeToon(output), report);
          }
        }
        // Publishing audience contracts and upgrades cannot write or normalize native state.
        buildAudienceContracts({ items: readback });
        assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot })).items, readback);
      }
      // Exercise every existing exporter branch against each random state, including file output.
      const beforeExport = (await listAllComplete({ includeBody: true }, { pmRoot })).items;
      for (const format of ["json", "md"]) {
        for (const file of [false, true]) {
          const output = join(cwd, `export.${format}`);
          const result = await runRegisteredCommandForTest(activation.commands, { command: "changelog export", pmRoot,
            options: { format, "group-by": "release", ...(file ? { output } : {}) } });
          const payload = result.result as { output?: string; changelog?: string };
          const value = file ? readFileSync(output, "utf8") : format === "json" ? payload.output! : payload.changelog!;
          const markdown = format === "json" ? (JSON.parse(value) as { markdown: string }).markdown : value;
          for (const model of models.values()) assert.ok(markdown.includes(model.title));
        }
      }
      assert.deepEqual((await listAllComplete({ includeBody: true }, { pmRoot })).items, beforeExport);
    }
    assert.equal(variants.size, 4);
  });
});
