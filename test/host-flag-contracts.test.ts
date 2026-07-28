import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { activateExtensionForTest } from "@unbrained/pm-cli/sdk/testing";
import type {
  ExtensionActivationResult,
  ExtensionCapability,
  FlagDefinition,
} from "@unbrained/pm-cli/sdk/authoring";
import {
  GLOBAL_FLAG_CONTRACTS,
  SUBCOMMAND_GLOBAL_FLAG_CONTRACTS,
  type CliFlagContract,
} from "@unbrained/pm-cli/sdk/contracts";

import extension from "../dist/extension.js";

/**
 * Capabilities the on-disk `manifest.json` declares.
 *
 * Read from the manifest so activation runs under the exact grant the published
 * package ships with: a surface registered without a matching declared
 * capability fails here the same way it fails in the CLI, rather than passing
 * against a permissive stub.
 */
const parsedManifest: unknown = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf-8"),
);
assert.ok(
  parsedManifest !== null && typeof parsedManifest === "object",
  "manifest.json must parse to an object",
);
const declaredCapabilities = (parsedManifest as { capabilities?: unknown }).capabilities;
assert.ok(
  Array.isArray(declaredCapabilities) && declaredCapabilities.every((entry) => typeof entry === "string"),
  "manifest.json must declare capabilities as an array of strings",
);
const MANIFEST_CAPABILITIES = declaredCapabilities as readonly ExtensionCapability[];

let cachedActivation: Promise<ExtensionActivationResult> | undefined;

/**
 * Activate pm-changelog through pm's real extension loader, once per test process.
 *
 * Activation is deterministic and side-effect free, so the result is memoized
 * and shared. Asserting `failed` here means a broken activation surfaces as a
 * clear failure rather than as empty registration lists downstream.
 */
function activateChangelog(): Promise<ExtensionActivationResult> {
  cachedActivation ??= (async () => {
    const activation = await activateExtensionForTest(extension, {
      name: "pm-changelog",
      capabilities: MANIFEST_CAPABILITIES,
    });
    assert.deepEqual(activation.failed, [], "extension activation must not fail");
    return activation;
  })();
  return cachedActivation;
}

/**
 * Every host-owned flag string that an extension MUST NOT declare, drawn
 * directly from the host's machine-readable contracts (`sdk/contracts`).
 *
 * Combines {@link GLOBAL_FLAG_CONTRACTS} and {@link SUBCOMMAND_GLOBAL_FLAG_CONTRACTS},
 * folding in each contract's canonical `flag`, optional `short`, and every
 * `aliases` entry. Importing the live SDK data (rather than a hardcoded copy)
 * means this gate tracks the host automatically: if pm-cli ever claims a new
 * global flag, this test starts enforcing it without a package-side edit.
 */
function hostOwnedFlagSet(): Set<string> {
  const owned = new Set<string>();
  for (const contract of [
    ...GLOBAL_FLAG_CONTRACTS,
    ...SUBCOMMAND_GLOBAL_FLAG_CONTRACTS,
  ] as CliFlagContract[]) {
    if (contract.flag) owned.add(contract.flag);
    if (contract.short) owned.add(contract.short);
    for (const alias of contract.aliases ?? []) owned.add(alias);
  }
  return owned;
}

/** A flag declared by the extension, annotated with the command path it rides on. */
interface DeclaredFlag {
  command: string;
  long?: string;
  short?: string;
  aliases?: string[];
}

/**
 * Collect every flag the extension declares across all registration surfaces.
 *
 * pm-cli routes three flag-bearing registration surfaces into a single
 * `activation.registrations.flags` registry:
 *   1. `registerCommand` definitions — the command's `flags` array surfaces
 *      under the command path (e.g. "changelog generate").
 *   2. `registerFlags(targetCommand, flags)` — standalone flag grants, also
 *      under the target command path.
 *   3. `registerExporter`/`registerImporter` `options.flags` — the auto-created
 *      "<name> export"/"<name> import" command path carries these.
 *
 * Walking `registrations.flags` therefore covers all three surfaces. The
 * command-definition entries in `registrations.commands` carry no `flags` field
 * (flags live only in the flags registry), so there is no second source to
 * merge. Enumerating the surfaces here keeps the gate honest: if a future
 * surface stops routing through `registrations.flags`, this collector silently
 * drops it, so the surfaces list above is the contract this gate enforces.
 */
function collectDeclaredFlags(activation: ExtensionActivationResult): DeclaredFlag[] {
  const declared: DeclaredFlag[] = [];
  for (const entry of activation.registrations.flags) {
    for (const flag of entry.flags as FlagDefinition[]) {
      // `FlagDefinition` is an open shape (`[key: string]: unknown`); read the
      // optional `aliases` array defensively so a host that adds alias support
      // is still gated rather than silently bypassed.
      const aliases = Array.isArray(flag.aliases)
        ? (flag.aliases as string[]).filter((alias) => typeof alias === "string")
        : undefined;
      declared.push({
        command: entry.target_command,
        long: flag.long,
        short: flag.short,
        aliases,
      });
    }
  }
  return declared;
}

/**
 * Find the first declared flag that collides with a host-owned flag.
 *
 * Returns a descriptive string (offending flag + command) when a collision
 * exists, or `undefined` when the extension declares only host-safe flags.
 * Comparing `long`, `short`, and `aliases` against the full host-owned set
 * catches a shadow regardless of which spelling the extension used.
 */
function findHostFlagCollision(
  declared: readonly DeclaredFlag[],
  owned: ReadonlySet<string>,
): string | undefined {
  for (const flag of declared) {
    const spellings = [flag.long, flag.short, ...(flag.aliases ?? [])].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    for (const spelling of spellings) {
      if (owned.has(spelling)) {
        return `host-owned flag "${spelling}" declared on "${flag.command}"`;
      }
    }
  }
  return undefined;
}

test("extension declares no host-owned flags (sdk/contracts gate)", async () => {
  const activation = await activateChangelog();
  const declared = collectDeclaredFlags(activation);

  // Sanity: the gate must inspect real registrations, not silently pass by
  // collecting zero flags. Both subcommands register flags, so a non-zero
  // count confirms the collector walked the live registry.
  assert.ok(
    declared.length > 0,
    "the contracts gate must collect at least one declared flag; zero would make it a no-op",
  );

  const owned = hostOwnedFlagSet();
  const collision = findHostFlagCollision(declared, owned);
  assert.equal(
    collision,
    undefined,
    `extension must not declare host-owned flags: ${collision ?? "(none)"}`,
  );
});

test("host-flag collision detector catches a synthetic --json declaration", () => {
  // Negative case: prove the detector returns a hit for a synthetic `--json`
  // declaration, so the gate above cannot silently pass by collecting zero
  // flags or by a broken `owned` set. `--json` is owned by both global and
  // subcommand-global contracts, so it is the canonical collision.
  const owned = hostOwnedFlagSet();
  assert.ok(owned.has("--json"), "the host contracts must own --json for the negative case");

  const synthetic: DeclaredFlag[] = [
    { command: "changelog synthetic", long: "--json" },
  ];
  const collision = findHostFlagCollision(synthetic, owned);
  assert.ok(
    collision !== undefined,
    "the collision detector must report a synthetic --json declaration",
  );
  assert.match(
    collision as string,
    /--json/,
    "the collision message must name the offending flag",
  );
  assert.match(
    collision as string,
    /changelog synthetic/,
    "the collision message must name the command the flag was declared on",
  );
});