/** Host and standalone transports share the same bounded file-ingestion options. */
export declare const RELEASE_CORRECTION_FLAGS: {
    long: string;
    value_name: string;
    description: string;
}[];
/** Validate command selectors before touching storage, then delegate to the typed SDK surface. */
export declare function runReleaseCorrectionsCommand(pmRoot: string, action: string, options: Record<string, unknown>, json?: boolean, author?: string): Promise<string>;
/** Parse standalone correction commands independently from historical generation flags. */
export declare function runReleaseCorrectionsCli(args: string[]): Promise<void>;
//# sourceMappingURL=release-correction-command.d.ts.map