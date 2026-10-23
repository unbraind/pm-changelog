/** Shared host/standalone flags; all generation reads certified core metadata directly. */
export declare const AUDIENCE_CONTRACT_FLAGS: {
    long: string;
    value_name: string;
    description: string;
}[];
/** Validate command options before any read and use the same SDK report in both transports. */
export declare function runAudienceContractsCommand(pmRoot: string, options: Record<string, unknown>, json?: boolean): Promise<string>;
/** Standalone command parser, deliberately independent of git and markdown publication flags. */
export declare function runAudienceContractsCli(args: string[]): Promise<void>;
//# sourceMappingURL=audience-command.d.ts.map