/** Shared host and standalone flags, with no apply or execution mode. */
export declare const CONSUMER_UPGRADE_FLAGS: {
    long: string;
    value_name: string;
    description: string;
}[];
/** Validate transport flags and return the same read-only SDK report for both CLIs. */
export declare function runConsumerUpgradesCommand(pmRoot: string, options: Record<string, unknown>, json?: boolean): Promise<string>;
/** Parse standalone flags without generation flags, subprocesses or git discovery. */
export declare function runConsumerUpgradesCli(args: string[]): Promise<void>;
//# sourceMappingURL=consumer-upgrade-command.d.ts.map