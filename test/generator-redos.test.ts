import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "generator-redos-worker.ts");
const PATHOLOGICAL_SIZE = 50_000;
const STARTUP_BUDGET_MS = 5_000;
const OPERATION_BUDGET_MS = 250;

/** Run one synchronous generator path in an already-loaded child process so a
 * pre-fix backtracking hang can be terminated and the budget excludes module
 * startup. */
function assertCompletesWithinBudget(operation: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, "--server", String(PATHOLOGICAL_SIZE)], {
      cwd: dirname(WORKER),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    let settled = false;
    let operationTimer: NodeJS.Timeout | undefined;
    const startupTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${operation} worker did not start within ${STARTUP_BUDGET_MS}ms`));
    }, STARTUP_BUDGET_MS);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (operationTimer) clearTimeout(operationTimer);
      if (error) reject(error);
      else resolve();
    };

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!ready && stdout.includes("ready\n")) {
        ready = true;
        clearTimeout(startupTimer);
        operationTimer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(new Error(`${operation} exceeded ${OPERATION_BUDGET_MS}ms`));
        }, OPERATION_BUDGET_MS);
        child.stdin.end(`${operation}\n`);
      }
      if (ready && stdout.includes("ok\n")) finish();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (settled) return;
      finish(new Error(`${operation} exited before completion (${code ?? signal}): ${stderr}`));
    });
  });
}

test("release version extraction completes for a long separator-free heading", async () => {
  await assertCompletesWithinBudget("section-version");
});

test("summary heading formatting completes for a long separator-free heading", async () => {
  await assertCompletesWithinBudget("summary-format");
});

test("generated release extraction completes for a long whitespace heading", async () => {
  await assertCompletesWithinBudget("extract-release");
});

test("existing release replacement completes for a long whitespace heading", async () => {
  await assertCompletesWithinBudget("replace-release");
});

test("bracketed release normalization completes for malformed long input", async () => {
  await assertCompletesWithinBudget("bracketed-heading");
});

test("new release insertion completes when existing markdown has no release heading", async () => {
  await assertCompletesWithinBudget("insert-release");
});

test("title insertion completes for a long whitespace-heavy title", async () => {
  await assertCompletesWithinBudget("title-heading");
});
