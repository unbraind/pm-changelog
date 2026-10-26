# Published pm SDK capability floor

Audited main: `17fc812d87ea09f190ec0e95dae8ad339c6a992a`. Required API floor: **2026.8.18**.

Declared host floor: `2026.10.4`. npm peer: `>=2026.10.4`.

floor verified: the host declaration and the npm peer or exact runtime dependency already cover every API below. No floor change is needed.

## Artifact method and limits

The published version list was obtained with `npm view @unbrained/pm-cli versions --json`. Each capability was bisected over stable published releases, with its first providing release and adjacent previous stable release inspected. Prereleases do not satisfy these stable npm minimum ranges. Tarballs were downloaded with `npm pack @unbrained/pm-cli@VERSION --ignore-scripts` into an isolated scratch directory and inspected as data. No downloaded pm package code or lifecycle script was executed.

Public module exports were checked against both `package.json` entrypoints and the static ESM runtime export graph, then their `dist` declarations. Client methods and context members were read from the published declarations, including inherited members and static methods. A context property is attributed to the context used by this package, rather than a later base-interface refactor. TypeScript symbol resolution covers aliases, typed lazy loaders, destructuring, and clients passed through helpers. Erased interfaces do not create runtime requirements; imported function/constructor types used by loaders are retained conservatively.

This establishes API availability. It does not attest older-host runtime semantics, provider integration, or execution on the declared minimum. The current pinned SDK remains the local test host.

## API to first-version table

The machine-readable source inventory and artifact hashes are in [sdk-floor.json](sdk-floor.json). Source locations refer to the audited main commit.

| Used API | First stable release | Previous stable release lacking it | Source uses |
| --- | --- | --- | --- |
| `@unbrained/pm-cli/sdk :: analyzeRelationshipExecution` | 2026.7.15 | 2026.7.14 | [src/consumer-upgrades.ts:2](../src/consumer-upgrades.ts#L2) |
| `@unbrained/pm-cli/sdk :: defineExtension` | 2026.5.1 | 2026.3.12 | [src/extension.ts:4](../src/extension.ts#L4) |
| `@unbrained/pm-cli/sdk :: EXIT_CODE` | 2026.5.14 | 2026.5.12 | [src/upgrade-actions.ts:1](../src/upgrade-actions.ts#L1), [src/audience-contracts.ts:3](../src/audience-contracts.ts#L3), [src/milestones.ts:4](../src/milestones.ts#L4), [src/extension.ts:4](../src/extension.ts#L4) |
| `@unbrained/pm-cli/sdk :: getActiveExtensionRegistrations` | 2026.5.14 | 2026.5.12 | [src/extension.ts:4](../src/extension.ts#L4) |
| `@unbrained/pm-cli/sdk :: inspectCompleteListResult` | 2026.8.18 | 2026.8.17 | [src/generator.ts:8](../src/generator.ts#L8) |
| `@unbrained/pm-cli/sdk :: listAllComplete` | 2026.8.18 | 2026.8.17 | [src/audience-contracts.ts:3](../src/audience-contracts.ts#L3), [src/consumer-upgrades.ts:2](../src/consumer-upgrades.ts#L2), [src/milestones.ts:4](../src/milestones.ts#L4) |
| `@unbrained/pm-cli/sdk :: listAllItemMetadata` | 2026.7.13 | 2026.7.12 | [src/extension.ts:4](../src/extension.ts#L4) |
| `@unbrained/pm-cli/sdk :: locateItem` | 2026.5.14 | 2026.5.12 | [src/extension.ts:4](../src/extension.ts#L4) |
| `@unbrained/pm-cli/sdk :: parseItemDocument` | 2026.7.23 | 2026.7.22 | [src/release-membership.ts:6](../src/release-membership.ts#L6) |
| `@unbrained/pm-cli/sdk :: PmCliError` | 2026.5.14 | 2026.5.12 | [src/upgrade-actions.ts:1](../src/upgrade-actions.ts#L1), [src/audience-contracts.ts:3](../src/audience-contracts.ts#L3), [src/milestones.ts:4](../src/milestones.ts#L4), [src/extension.ts:4](../src/extension.ts#L4) |
| `@unbrained/pm-cli/sdk :: readLocatedItem` | 2026.5.14 | 2026.5.12 | [src/extension.ts:4](../src/extension.ts#L4) |
| `@unbrained/pm-cli/sdk :: readSettings` | 2026.5.14 | 2026.5.12 | [src/extension.ts:4](../src/extension.ts#L4) |
| `@unbrained/pm-cli/sdk :: readSettingsWithMetadata` | 2026.7.23 | 2026.7.22 | [src/release-membership.ts:6](../src/release-membership.ts#L6) |
| `@unbrained/pm-cli/sdk :: RelationshipGraph` | 2026.7.15 | 2026.7.14 | [src/consumer-upgrades.ts:2](../src/consumer-upgrades.ts#L2) |
| `@unbrained/pm-cli/sdk :: resolveCompletionTimestamp` | 2026.7.29 | 2026.7.28 | [src/generator.ts:8](../src/generator.ts#L8) |
| `@unbrained/pm-cli/sdk :: resolveItemTypeRegistry` | 2026.5.14 | 2026.5.12 | [src/extension.ts:4](../src/extension.ts#L4) |
| `@unbrained/pm-cli/sdk :: resolvePmRoot` | 2026.5.14 | 2026.5.12 | [src/audience-command.ts:2](../src/audience-command.ts#L2), [src/consumer-upgrade-command.ts:2](../src/consumer-upgrade-command.ts#L2), [src/cli.ts:9](../src/cli.ts#L9) |
| `@unbrained/pm-cli/sdk :: SETTINGS_DEFAULTS` | 2026.7.23 | 2026.7.22 | [src/release-membership.ts:6](../src/release-membership.ts#L6) |
| `@unbrained/pm-cli/sdk/runtime :: certifyCompleteListResult` | 2026.8.18 | 2026.8.17 | [src/generator.ts:9](../src/generator.ts#L9) |
| `CommandHandlerContext.args` | 2026.5.1 | 2026.3.12 | [src/extension.ts:119](../src/extension.ts#L119) |
| `CommandHandlerContext.global` | 2026.5.1 | 2026.3.12 | [src/extension.ts:102](../src/extension.ts#L102), [src/extension.ts:110](../src/extension.ts#L110), [src/extension.ts:331](../src/extension.ts#L331) |
| `CommandHandlerContext.options` | 2026.5.1 | 2026.3.12 | [src/extension.ts:102](../src/extension.ts#L102), [src/extension.ts:110](../src/extension.ts#L110), [src/extension.ts:121](../src/extension.ts#L121), [src/extension.ts:187](../src/extension.ts#L187), [src/extension.ts:188](../src/extension.ts#L188), [src/extension.ts:189](../src/extension.ts#L189), [src/extension.ts:190](../src/extension.ts#L190), [src/extension.ts:202](../src/extension.ts#L202), [src/extension.ts:208](../src/extension.ts#L208), [src/extension.ts:214](../src/extension.ts#L214), [src/extension.ts:216](../src/extension.ts#L216), [src/extension.ts:220](../src/extension.ts#L220), [src/extension.ts:225](../src/extension.ts#L225), [src/extension.ts:227](../src/extension.ts#L227), [src/extension.ts:228](../src/extension.ts#L228), [src/extension.ts:231](../src/extension.ts#L231), [src/extension.ts:232](../src/extension.ts#L232), [src/extension.ts:233](../src/extension.ts#L233), [src/extension.ts:234](../src/extension.ts#L234), [src/extension.ts:235](../src/extension.ts#L235), [src/extension.ts:236](../src/extension.ts#L236), [src/extension.ts:237](../src/extension.ts#L237), [src/extension.ts:238](../src/extension.ts#L238), [src/extension.ts:242](../src/extension.ts#L242), [src/extension.ts:246](../src/extension.ts#L246), [src/extension.ts:248](../src/extension.ts#L248), [src/extension.ts:258](../src/extension.ts#L258), [src/extension.ts:262](../src/extension.ts#L262), [src/extension.ts:270](../src/extension.ts#L270), [src/extension.ts:288](../src/extension.ts#L288), [src/extension.ts:289](../src/extension.ts#L289), [src/extension.ts:290](../src/extension.ts#L290), [src/extension.ts:292](../src/extension.ts#L292), [src/extension.ts:293](../src/extension.ts#L293), [src/extension.ts:295](../src/extension.ts#L295), [src/extension.ts:296](../src/extension.ts#L296), [src/extension.ts:297](../src/extension.ts#L297), [src/extension.ts:298](../src/extension.ts#L298), [src/extension.ts:299](../src/extension.ts#L299), [src/extension.ts:300](../src/extension.ts#L300), [src/extension.ts:301](../src/extension.ts#L301), [src/extension.ts:302](../src/extension.ts#L302), [src/extension.ts:303](../src/extension.ts#L303), [src/extension.ts:320](../src/extension.ts#L320), [src/extension.ts:327](../src/extension.ts#L327), [src/extension.ts:328](../src/extension.ts#L328), [src/extension.ts:332](../src/extension.ts#L332), [src/extension.ts:338](../src/extension.ts#L338), [src/extension.ts:344](../src/extension.ts#L344), [src/extension.ts:371](../src/extension.ts#L371), [src/extension.ts:372](../src/extension.ts#L372), [src/extension.ts:414](../src/extension.ts#L414), [src/extension.ts:416](../src/extension.ts#L416), [src/extension.ts:426](../src/extension.ts#L426), [src/extension.ts:439](../src/extension.ts#L439) |
| `CommandHandlerContext.pm_root` | 2026.5.1 | 2026.3.12 | [src/extension.ts:102](../src/extension.ts#L102), [src/extension.ts:110](../src/extension.ts#L110), [src/extension.ts:120](../src/extension.ts#L120), [src/extension.ts:121](../src/extension.ts#L121), [src/extension.ts:240](../src/extension.ts#L240), [src/extension.ts:257](../src/extension.ts#L257), [src/extension.ts:269](../src/extension.ts#L269), [src/extension.ts:274](../src/extension.ts#L274), [src/extension.ts:305](../src/extension.ts#L305), [src/extension.ts:311](../src/extension.ts#L311), [src/extension.ts:315](../src/extension.ts#L315) |
| `ExtensionApi.registerCommand` | 2026.5.1 | 2026.3.12 | [src/extension.ts:97](../src/extension.ts#L97), [src/extension.ts:105](../src/extension.ts#L105), [src/extension.ts:113](../src/extension.ts#L113), [src/extension.ts:125](../src/extension.ts#L125), [src/extension.ts:431](../src/extension.ts#L431), [src/extension.ts:432](../src/extension.ts#L432) |
| `ExtensionApi.registerExporter` | 2026.5.1 | 2026.3.12 | [src/extension.ts:487](../src/extension.ts#L487) |
| `ExtensionApi.registerItemFields` | 2026.5.1 | 2026.3.12 | [src/extension.ts:96](../src/extension.ts#L96) |
| `ExtensionApi.registerRenderer` | 2026.5.1 | 2026.3.12 | [src/extension.ts:567](../src/extension.ts#L567), [src/extension.ts:577](../src/extension.ts#L577), [src/extension.ts:578](../src/extension.ts#L578) |
| `ImportExportContext.options` | 2026.5.1 | 2026.3.12 | [src/extension.ts:488](../src/extension.ts#L488), [src/extension.ts:492](../src/extension.ts#L492), [src/extension.ts:496](../src/extension.ts#L496), [src/extension.ts:497](../src/extension.ts#L497), [src/extension.ts:498](../src/extension.ts#L498), [src/extension.ts:499](../src/extension.ts#L499), [src/extension.ts:500](../src/extension.ts#L500), [src/extension.ts:501](../src/extension.ts#L501), [src/extension.ts:507](../src/extension.ts#L507), [src/extension.ts:508](../src/extension.ts#L508), [src/extension.ts:509](../src/extension.ts#L509), [src/extension.ts:511](../src/extension.ts#L511), [src/extension.ts:513](../src/extension.ts#L513), [src/extension.ts:519](../src/extension.ts#L519), [src/extension.ts:521](../src/extension.ts#L521), [src/extension.ts:526](../src/extension.ts#L526), [src/extension.ts:527](../src/extension.ts#L527), [src/extension.ts:528](../src/extension.ts#L528), [src/extension.ts:529](../src/extension.ts#L529), [src/extension.ts:530](../src/extension.ts#L530), [src/extension.ts:531](../src/extension.ts#L531), [src/extension.ts:532](../src/extension.ts#L532), [src/extension.ts:533](../src/extension.ts#L533), [src/extension.ts:541](../src/extension.ts#L541) |
| `ImportExportContext.pm_root` | 2026.5.1 | 2026.3.12 | [src/extension.ts:505](../src/extension.ts#L505), [src/extension.ts:516](../src/extension.ts#L516), [src/extension.ts:535](../src/extension.ts#L535) |

## Tarball provenance

SHA-256 of the exact packed `.tgz` bytes; package archives and extracted files are not committed.

| pm release | Tarball SHA-256 |
| --- | --- |
| 2026.3.12 | `4e4e6a33cb45d665f072120e9e1ce25d2e5773e738cbc914b29e8f54367747fb` |
| 2026.5.1 | `730de8b79aa0074dc2ca81a54ce37f9aaa0a4167b690c9a62b87d2121a8b37f7` |
| 2026.5.12 | `42dcaef84dc441b7792aeffa059bfe10a86ae8b12b1084472229bba03fb29910` |
| 2026.5.14 | `7f7e9131afadb891344bf2fb93b15bc157d18c532a5da4ec31677957d37b7260` |
| 2026.7.12 | `a612224324e3ae91e2fc8c25f83d9a65fc13db66914aeb04ee65e16a523521be` |
| 2026.7.13 | `10d5b0f8787c643cb8caf58f656cc95097f6ac84fcdaa6ff59911780fcd894a5` |
| 2026.7.14 | `4a42de258a3b1cabff1112dd90ae4f3cc272e25ada229d818becae0f2845e128` |
| 2026.7.15 | `1c5d8e7427d74af157577ff58e0692a986016ee355eaf3a6b5ccebca5a9779aa` |
| 2026.7.22 | `d013832d6afc97c9a5c6f4a48a497f54a216643f8c7017b9c4f807ce6607532b` |
| 2026.7.23 | `caf1a21b0b587dc55c3509654466dd1e20383e30f2d17b47678887a15a5490af` |
| 2026.7.28 | `aed7dc6af73cf396dc6a6d6069a1a230a5a45503329b257316a5ae455f5c3f82` |
| 2026.7.29 | `70a5e5e6b1a908a0dc5b1f16700a4dbe4c2546ce18e01c9d20863d4746d36e93` |
| 2026.8.17 | `fda330eb4887031751889ef85b510d52886fa5f70b4813f3951d7eed705023f2` |
| 2026.8.18 | `b00374f0e32c98ccec03a5893d8bfbbae45650f44bd04292ceafd8d9aac059f7` |
