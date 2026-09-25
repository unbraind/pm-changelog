import { createChangelogSummary, formatSummaryLine, mergeChangelog, parseDependencyCommit, resolveGithubOwnerRepo } from "../src/index.ts";

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
    case "dep-parse": {
      // Exercise DEPENDABOT_SUBJECT and PR_NUMBER with a long matching subject.
      const subject = `build(deps-dev): bump ${"x".repeat(size)} from 1.0.0 to 2.0.0 (#${"1".repeat(size)})`;
      const result = parseDependencyCommit(subject);
      if (!result) throw new Error("dep-parse operation did not match a Dependabot subject");
      break;
    }
    case "dep-nonmatch": {
      // Exercise the non-matching path of DEPENDABOT_SUBJECT with a long
      // string that starts like a conventional commit but lacks the deps scope.
      const subject = `feat: ${"x".repeat(size)}`;
      const result = parseDependencyCommit(subject);
      if (result) throw new Error("dep-nonmatch should not match a non-Dependabot subject");
      break;
    }
    case "dep-github-url": {
      // Exercise GITHUB_URL_PREFIX with a long path after owner/repo.
      const url = `https://github.com/owner/repo/blob/main/${"x".repeat(size)}`;
      const result = resolveGithubOwnerRepo(url);
      if (!result) throw new Error("dep-github-url operation did not extract owner/repo");
      break;
    }
    case "dep-github-nonmatch": {
      // Exercise the non-matching path of GITHUB_URL_PREFIX with a long
      // non-GitHub URL.
      const url = `https://example.test/${"x".repeat(size)}`;
      const result = resolveGithubOwnerRepo(url);
      if (result) throw new Error("dep-github-nonmatch should not match a non-GitHub URL");
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
    const started = process.cpuUsage();
    runOperation(commandText.trim());
    const used = process.cpuUsage(started);
    process.stdout.write(`ok ${used.user + used.system}\n`);
  });
}
