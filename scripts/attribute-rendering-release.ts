import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readPublicationState, resolveRenderingReleaseBoundary } from "./rendering-release-boundary.ts";
import type { PmItem } from "../src/types.ts";
import type { PublicationState } from "./rendering-release-boundary.ts";
import { listAllComplete, resolveCompletionTimestamp, readSettings, resolveRuntimeStatusRegistry, runUpdate } from "@unbrained/pm-cli/sdk";
import { getStringField } from "../src/generator.ts";
import { isDoneStatus, isNonChangeClosure } from "../src/closure-policy.ts";
import { parseContractRelease } from "../src/contract-versions.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Attribute delivered rendering declarations only once a release version is
 * explicitly selected. The release PR commits the native items and histories. */
export async function attributeRenderingRelease(pmRoot: string, deliveryVersion: string, options: { cwd: string; preparedFrom: string; publication: PublicationState; log?: (item: string, reason: string) => void } = { cwd: process.cwd(), preparedFrom: "", publication: { state: "unknown" } }): Promise<string[]> {
  const release = parseContractRelease(deliveryVersion);
  assert.ok(release, "A selected stable delivery version is required before tracker attribution");
  const items = (await listAllComplete({}, { pmRoot })).items;
  const context = { statusRegistry: resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema) };
  const changed: string[] = [];
  const boundary = await resolveRenderingReleaseBoundary(options.cwd, pmRoot, release, options.preparedFrom, options.publication);
  const log = options.log ?? ((item: string, reason: string) => console.error(JSON.stringify({ item, reason })));
  for (const item of items) {
    if (!item.tags?.includes("rendering-change") || !isDoneStatus(item, context) || isNonChangeClosure(item, context)
      || getStringField(item, "release") !== undefined) continue;
    const frozen = boundary?.items.get(item.id);
    const metadata = (item as PmItem).metadata;
    const completion = resolveCompletionTimestamp({ completed_at: item.completed_at, closed_at: item.closed_at });
    const original = frozen && resolveCompletionTimestamp({ completed_at: frozen.completed_at, closed_at: frozen.closed_at });
    const time = completion.resolved ? Date.parse(completion.timestamp) : NaN;
    if (!boundary || !frozen || !isDoneStatus(frozen, context) || !frozen.tags?.includes("rendering-change")
      || (getStringField(frozen, "release") !== undefined && getStringField(frozen, "release") !== release)
      || !original?.resolved || !Number.isFinite(time) || time >= boundary.timestamp || time !== Date.parse(original.timestamp)
      || !isDeepStrictEqual(item.change_facets, frozen.change_facets) || !isDeepStrictEqual(item.contract_change, frozen.contract_change)
      || !isDeepStrictEqual(metadata?.contract_change, frozen.metadata?.contract_change)
      || !isDeepStrictEqual(metadata?.change_facets, frozen.metadata?.change_facets)) {
      log(item.id, "completion_or_declaration_not_proved_before_release_commit");
      continue;
    }
    await runUpdate(item.id, { release }, { path: pmRoot });
    changed.push(item.id);
  }
  return changed;
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const cwd = process.cwd(), version = process.argv[2] ?? "";
  const name: unknown = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")).name;
  assert.equal(typeof name, "string");
  assert.ok(parseContractRelease(version), "A selected stable delivery version is required before tracker attribution");
  const publication = await readPublicationState(String(name), version);
  console.log(JSON.stringify({ attributed: await attributeRenderingRelease(resolve(cwd, ".agents/pm"), version,
    { cwd, preparedFrom: process.argv[3] ?? "", publication }) }));
}
