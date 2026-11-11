/** Failure categories describe observable output, never a successful check. */
export type CheckDriftClassification = "reorder_only" | "rendering_changed" | "tracker_changed";
/** Classify an actual difference, checking pure section-local reordering before
 * exact equality with the preceding shared renderer on the same tracker.
 * A lazy previous rendering avoids extra generation for ordinary reorder drift. */
export declare function classifyCheckDrift(committed: string, generated: string, previous: () => string): CheckDriftClassification;
/** Reproduce the configured entrypoint and arguments, removing only the check
 * flag (never an option value). Wrapper scripts keep their own configuration. */
export declare function regenerationCommand(args: string[], valueOptions: ReadonlySet<string>, fallback?: string[]): string;
//# sourceMappingURL=check-drift.d.ts.map