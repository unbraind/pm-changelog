import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { ChangelogReleaseWindow } from "./types.js";

export interface ReleaseContextOptions {
  cwd?: string;
  version?: string;
  versionFromPackage?: boolean;
  since?: string;
  sincePreviousTag?: boolean;
  until?: string;
  untilReleaseTag?: boolean;
}

export interface ReleaseTagHistoryOptions {
  cwd?: string;
  tagPattern?: string;
  includeUnreleased?: boolean;
  pendingVersion?: string;
  pendingTimestamp?: string;
}

interface ReleaseTag {
  name: string;
  timestamp: string;
}

export interface ReleaseContext {
  version?: string;
  date?: string;
  since?: string;
  until?: string;
  releaseTag?: string;
  previousTag?: string;
}

export function resolveReleaseContext(options: ReleaseContextOptions): ReleaseContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  const version = options.version ?? (options.versionFromPackage ? readPackageVersion(cwd) : undefined);
  const releaseTag = version ? findExistingTag(cwd, releaseTagCandidates(version)) : undefined;
  const previousTag = options.sincePreviousTag ? findPreviousTag(cwd, releaseTag) : undefined;
  const releaseTimestamp = releaseTag ? tryGitCommitTimestamp(cwd, releaseTag) : undefined;

  return {
    version,
    date: releaseTimestamp ? formatLocalTimestampDate(releaseTimestamp) : undefined,
    releaseTag,
    previousTag,
    since: options.since ?? (previousTag ? gitCommitTimestamp(cwd, previousTag) : undefined),
    until: options.until ?? (options.untilReleaseTag ? releaseTimestamp : undefined),
  };
}

export function resolveReleaseTagWindows(options: ReleaseTagHistoryOptions = {}): ChangelogReleaseWindow[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const tags = listReleaseTags(cwd, options.tagPattern ?? "v*");
  const pending = resolvePendingReleaseTag(options, tags);
  const orderedTags = pending ? [pending, ...tags] : tags;
  if (orderedTags.length === 0) return [];

  const windows: ChangelogReleaseWindow[] = [];
  if (options.includeUnreleased !== false) {
    windows.push({
      heading: "Unreleased",
      since: orderedTags[0].timestamp,
      sinceExclusive: true,
    });
  }

  for (let index = 0; index < orderedTags.length; index++) {
    const tag = orderedTags[index];
    const previous = orderedTags[index + 1];
    windows.push({
      heading: `${formatTagVersion(tag.name)} - ${formatLocalTimestampDate(tag.timestamp)}`,
      releaseTag: tag.name,
      since: previous?.timestamp,
      sinceExclusive: Boolean(previous),
      until: tag.timestamp,
    });
  }

  return windows;
}

function resolvePendingReleaseTag(options: ReleaseTagHistoryOptions, existingTags: ReleaseTag[]): ReleaseTag | undefined {
  const version = options.pendingVersion?.trim();
  if (!version) return undefined;
  const candidates = releaseTagCandidates(version);
  const candidateSet = new Set(candidates);
  if (existingTags.some((tag) => candidateSet.has(tag.name))) return undefined;
  const canonical = canonicalPendingTagName(candidates, version);
  const timestamp = normalizeTimestamp(options.pendingTimestamp ?? new Date().toISOString());
  return { name: canonical, timestamp };
}

function canonicalPendingTagName(candidates: string[], fallback: string): string {
  const preferred = candidates.find((candidate) => /^v\d{4}\.\d{2}\.\d{2}/.test(candidate))
    ?? candidates.find((candidate) => candidate.startsWith("v"))
    ?? fallback;
  return preferred;
}

function readPackageVersion(cwd: string): string {
  const packageJsonPath = findPackageJson(cwd);
  if (!packageJsonPath) {
    throw new Error("--release-version-from-package requires a package.json in the current directory or an ancestor");
  }
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error(`${packageJsonPath} does not contain a valid version field`);
  }
  return parsed.version;
}

function findPackageJson(start: string): string | undefined {
  let current = start;
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function findExistingTag(cwd: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const result = runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/tags/${candidate}`]);
    if (result) return candidate;
  }
  return undefined;
}

function releaseTagCandidates(version: string): string[] {
  const trimmed = version.trim();
  const candidates = [`v${trimmed}`, trimmed];
  const calendar = trimmed.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(-.+)?$/);
  if (calendar) {
    const [, year, month, day, suffix = ""] = calendar;
    const padded = `${year}.${month.padStart(2, "0")}.${day.padStart(2, "0")}${suffix}`;
    candidates.push(`v${padded}`, padded);
  }
  return Array.from(new Set(candidates));
}

function findPreviousTag(cwd: string, releaseTag: string | undefined): string | undefined {
  const ref = releaseTag ? `${releaseTag}^` : "HEAD";
  return runGit(cwd, ["describe", "--tags", "--abbrev=0", ref]);
}

function listReleaseTags(cwd: string, pattern: string): ReleaseTag[] {
  const output = runGit(cwd, [
    "tag",
    "--list",
    pattern,
    "--merged",
    "HEAD",
    "--format=%(refname:short)%09%(*committerdate:iso-strict)%09%(committerdate:iso-strict)",
  ]);
  if (!output) return [];
  return output
    .split("\n")
    .map(parseTagLine)
    .filter((tag): tag is ReleaseTag => Boolean(tag))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function parseTagLine(line: string): ReleaseTag | undefined {
  const [name, peeledCommitterDate, directCommitterDate] = line.split("\t");
  const tagName = name?.trim();
  const timestamp = (peeledCommitterDate || directCommitterDate)?.trim();
  if (!tagName || !timestamp) return undefined;
  return { name: tagName, timestamp };
}

function gitCommitTimestamp(cwd: string, ref: string): string {
  const timestamp = runGit(cwd, ["log", "-1", "--format=%cI", ref]);
  if (!timestamp) {
    throw new Error(`Could not resolve git timestamp for ${ref}`);
  }
  return timestamp;
}

function tryGitCommitTimestamp(cwd: string, ref: string): string | undefined {
  try {
    return gitCommitTimestamp(cwd, ref);
  } catch {
    return undefined;
  }
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function formatTagVersion(tag: string): string {
  return tag.replace(/^v/i, "");
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function formatLocalTimestampDate(timestamp: string): string {
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/);
  if (match) return match[1];
  return formatDate(timestamp);
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}
