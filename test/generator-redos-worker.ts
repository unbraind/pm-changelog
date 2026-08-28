import { createChangelogSummary, formatSummaryLine, mergeChangelog } from "../src/index.ts";

const serverMode = process.argv[2] === "--server";
const operation = serverMode ? undefined : process.argv[2];
const sizeArgument = process.argv[3];
const size = Number(sizeArgument);
if (!Number.isSafeInteger(size) || size < 1) {
  throw new Error(`invalid stress size: ${sizeArgument}`);
}

/** Execute one public generator path with a deliberately hostile whitespace
 * input. The parent test runs this in an already-loaded child so its budget
 * measures the operation rather than TypeScript/SDK startup. */
function runOperation(selectedOperation: string): void {
  const spaces = " ".repeat(size);
  switch (selectedOperation) {
    case "section-version": {
      const entries = createChangelogSummary({
        items: [{ id: "redos", title: "Work", status: "closed" }],
        releaseWindows: [{ heading: `${spaces}x` }],
      });
      if (entries.length !== 1) throw new Error("section-version operation did not render one entry");
      break;
    }
    case "summary-format": {
      const line = formatSummaryLine({ heading: `${spaces}x`, category: "Other", title: "Work" });
      if (!line.endsWith("Other: Work")) throw new Error("summary-format operation returned an unexpected line");
      break;
    }
    case "extract-release": {
      const generated = `# Changelog\n\n## ${"  ".repeat(size)}x\n\n### Fixed\n\n- Work\n`;
      const merged = mergeChangelog("# Changelog\n", generated);
      if (!merged.markdown.includes("Work")) throw new Error("extract-release operation did not merge the release");
      break;
    }
    case "replace-release": {
      const existing = `# Changelog\n\n## ${"  ".repeat(size)}x\n\n### Fixed\n\n- Old\n`;
      const generated = "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n### Fixed\n\n- Work\n";
      const merged = mergeChangelog(existing, generated);
      if (!merged.markdown.includes("Work")) throw new Error("replace-release operation did not merge the release");
      break;
    }
    case "bracketed-heading": {
      const existing = `# Changelog\n\n## [\\] - ${spaces}x\n\n### Fixed\n\n- Old\n`;
      const generated = "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n### Fixed\n\n- Work\n";
      const merged = mergeChangelog(existing, generated);
      if (!merged.markdown.includes("Work")) throw new Error("bracketed-heading operation did not merge the release");
      break;
    }
    case "insert-release": {
      const existing = "# Changelog\n\nIntroductory prose.\n";
      const generated = "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n### Fixed\n\n- Work\n";
      const merged = mergeChangelog(existing, generated);
      if (!merged.markdown.includes("Work")) throw new Error("insert-release operation did not merge the release");
      break;
    }
    case "title-heading": {
      const existing = `# ${spaces}x\n\nIntroductory prose.\n`;
      const generated = "# Changelog\n\n## 1.0.0 - 2026-01-01\n\n### Fixed\n\n- Work\n";
      const merged = mergeChangelog(existing, generated);
      if (!merged.markdown.includes("Work")) throw new Error("title-heading operation did not merge the release");
      break;
    }
    default:
      throw new Error(`unknown operation: ${selectedOperation}`);
  }
}

if (!serverMode) {
  runOperation(operation!);
  process.stdout.write("ok\n");
} else {
  process.stdout.write("ready\n");
  process.stdin.setEncoding("utf-8");
  process.stdin.once("data", (command) => {
    const commandText = typeof command === "string" ? command : command.toString("utf-8");
    runOperation(commandText.trim());
    process.stdout.write("ok\n");
  });
}
