/** Shared flags keep the host command and standalone parser aligned. */
export declare const AGENT_CONTRACT_DRIFT_FLAGS: {
    long: string;
    value_name: string;
    description: string;
}[];
/** Validate guards before reading, then use the same projection for both transports. */
export declare function runAgentContractDriftCommand(pmRoot: string, options: Record<string, unknown>, json?: boolean): Promise<string>;
/** Standalone command performs no subprocess, git discovery or tracker writes. */
export declare function runAgentContractDriftCli(args: string[]): Promise<void>;
//# sourceMappingURL=agent-contract-command.d.ts.map