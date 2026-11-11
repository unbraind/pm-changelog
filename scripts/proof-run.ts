import assert from "node:assert/strict";

/** One attempted proof case, including failed seams and restored controls. */
export interface ProofCaseResult { name: string; passed: boolean; error?: string }

/** Run every case and defer the aggregate failure until restoration is checked. */
export class ProofRun {
  readonly results: ProofCaseResult[] = [];

  /** Capture a case failure without preventing later independent mutations. */
  run(name: string, action: () => void): void {
    let result: ProofCaseResult;
    try { action(); result = { name, passed: true }; }
    catch (error) { result = { name, passed: false, error: error instanceof Error ? error.message : String(error) }; }
    this.results.push(result);
    console.log(JSON.stringify({ proof_case: result }));
  }

  /** Report every result before failing the overall proof. */
  finish(): void {
    const failures = this.results.filter((result) => !result.passed);
    console.log(JSON.stringify({ attempted: this.results.length, passed: this.results.length - failures.length, failed: failures.length }));
    assert.equal(failures.length, 0, failures.map((result) => `${result.name}: ${result.error}`).join("\n"));
  }
}
