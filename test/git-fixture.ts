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

/** Retry transient directory races while removing an owned fixture tree. */
export function removeGitFixture(directory: string): void {
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
