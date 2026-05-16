import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

import { createChangelog, mergeChangelog, readPmItems } from "./generator.js";

const defineExtension: typeof defineExtensionType = ((extension: unknown) => extension) as typeof defineExtensionType;

export default defineExtension({
  name: "pm-changelog",
  version: "0.1.0",

  activate(api) {
    api.registerCommand({
      name: "changelog generate",
      description: "Generate a CHANGELOG.md file from pm items.",
      intent: "generate changelog release notes from completed pm items",
      examples: [
        "pm changelog generate",
        "pm changelog generate --version 1.2.0",
        "pm changelog generate --output RELEASE_NOTES.md --since 2026-05-01",
        "pm changelog generate --stdout --group-by milestone",
      ],
      flags: [
        { long: "--output", value_name: "file", description: "Output file path (default: CHANGELOG.md)" },
        { long: "--stdout", description: "Return markdown instead of writing a file" },
        { long: "--title", value_name: "text", description: "Changelog title (default: Changelog)" },
        { long: "--version", value_name: "version", description: "Version heading (default: Unreleased)" },
        { long: "--date", value_name: "date", description: "Release date (default: today)" },
        { long: "--since", value_name: "date", description: "Include items changed on or after this date" },
        { long: "--until", value_name: "date", description: "Include items changed on or before this date" },
        { long: "--status", value_name: "list", description: "Comma-separated statuses (default: closed)" },
        { long: "--group-by", value_name: "mode", description: "version or milestone (default: version)" },
        { long: "--mode", value_name: "mode", description: "replace or prepend existing changelog (default: replace)" },
        { long: "--include-empty", description: "Emit an empty release section when no items match" },
      ],
      async run(ctx) {
        const output = (ctx.options["output"] as string | undefined) ?? "CHANGELOG.md";
        const stdout = Boolean(ctx.options["stdout"]);
        const groupBy = (ctx.options["group-by"] as string | undefined) ?? "version";
        const mode = (ctx.options["mode"] as string | undefined) ?? "replace";

        if (groupBy !== "version" && groupBy !== "milestone") {
          return { error: "--group-by must be 'version' or 'milestone'" };
        }
        if (mode !== "replace" && mode !== "prepend") {
          return { error: "--mode must be 'replace' or 'prepend'" };
        }

        const statuses = (ctx.options["status"] as string | undefined)
          ?.split(",")
          .map((status) => status.trim())
          .filter(Boolean);

        const items = readPmItems({ pmRoot: ctx.pm_root });
        const generated = createChangelog({
          items,
          title: ctx.options["title"] as string | undefined,
          version: ctx.options["version"] as string | undefined,
          date: ctx.options["date"] as string | undefined,
          since: ctx.options["since"] as string | undefined,
          until: ctx.options["until"] as string | undefined,
          includeStatuses: statuses,
          groupBy,
          includeEmpty: Boolean(ctx.options["include-empty"]),
        });
        const outputPath = resolve(output);
        const existing = mode === "prepend" && existsSync(outputPath)
          ? readFileSync(outputPath, "utf-8")
          : undefined;
        const merged = mode === "prepend"
          ? mergeChangelog(existing, generated.markdown, { title: ctx.options["title"] as string | undefined })
          : { markdown: generated.markdown, action: "replaced" as const, changed: true };

        if (stdout) {
          return {
            changelog: merged.markdown,
            action: merged.action,
            changed: merged.changed,
            item_count: generated.itemCount,
          };
        }

        writeFileSync(outputPath, merged.markdown, "utf-8");
        return {
          file: outputPath,
          action: merged.action,
          changed: merged.changed,
          item_count: generated.itemCount,
          bytes: Buffer.byteLength(merged.markdown, "utf-8"),
        };
      },
    });
  },
});
