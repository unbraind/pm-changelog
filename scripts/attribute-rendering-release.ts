import assert from "node:assert/strict";
import { listAllComplete, readSettings, resolveRuntimeStatusRegistry, runUpdate } from "@unbrained/pm-cli/sdk";
import { getStringField } from "../src/generator.ts";
import { isDoneStatus, isNonChangeClosure } from "../src/closure-policy.ts";
import { parseContractRelease } from "../src/contract-versions.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Attribute delivered rendering declarations only once a release version is
 * explicitly selected. The release PR commits the native items and histories. */
export async function attributeRenderingRelease(pmRoot: string, deliveryVersion: string): Promise<string[]> {
  const release = parseContractRelease(deliveryVersion);
  assert.ok(release, "A selected stable delivery version is required before tracker attribution");
  const items = (await listAllComplete({}, { pmRoot })).items;
  const context = { statusRegistry: resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema) };
  const changed: string[] = [];
  for (const item of items) {
    if (!item.tags?.includes("rendering-change") || !isDoneStatus(item, context) || isNonChangeClosure(item, context)
      || getStringField(item, "release") !== undefined) continue;
    await runUpdate(item.id, { release }, { path: pmRoot });
    changed.push(item.id);
  }
  return changed;
}

if (isMainInvocation(process.argv, import.meta.url)) {
  console.log(JSON.stringify({ attributed: await attributeRenderingRelease(".agents/pm", process.argv[2] ?? "") }));
}
