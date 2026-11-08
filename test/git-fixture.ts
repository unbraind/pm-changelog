/** Shared lifecycle for real Git fixtures; subprocesses must stay foreground. */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const fixtureConfig = ["gc.auto=0", "maintenance.auto=false", "core.fsmonitor=false"];
const foregroundArgs = fixtureConfig.flatMap((setting) => ["-c", setting]);

/** Persist overrides so Git invoked by the production code also stays idle. */
function configureGitFixture(directory: string): void {
  for (const setting of fixtureConfig) {
    const separator = setting.indexOf("=");
    execFileSync("git", [...foregroundArgs, "config", "--local", setting.slice(0, separator), setting.slice(separator + 1)], { cwd: directory });
  }
}

/** Initialize a real repository without inheriting background Git work. */
export function initGitFixture(directory: string, args: string[] = []): void {
  execFileSync("git", [...foregroundArgs, "init", ...args], { cwd: directory, stdio: "pipe" });
  configureGitFixture(directory);
}

/** Clone with persisted overrides already active during the initial fetch. */
export function cloneGitFixture(directory: string, args: string[]): void {
  execFileSync("git", [...foregroundArgs, "clone", ...foregroundArgs, ...args, directory], { stdio: "pipe" });
}

/** Add an alias only when loose refs can represent it on case-insensitive filesystems. */
export function addGitTagAlias(directory: string, name: string, target: string): boolean {
  const names = execFileSync("git", ["tag", "--list"], { cwd: directory, encoding: "utf8" }).trim().split("\n");
  if (names.some((existing) => existing.toLowerCase() === name.toLowerCase())) return false;
  execFileSync("git", ["tag", name, target], { cwd: directory, stdio: "pipe" });
  return true;
}

/** Retry transient directory races while removing an owned fixture tree. */
export function removeGitFixture(directory: string): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
