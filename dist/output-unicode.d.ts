import { PmCliError } from "@unbrained/pm-cli/sdk";
/** Replace only lone UTF-16 code units; valid pairs, whitespace and controls remain exact. */
export declare function normalizeUnicodeText(value: string): string;
/** Refuse ambiguous dynamic keys instead of silently dropping a legacy field. */
export declare class UnicodeOutputError extends PmCliError {
    /** Stable discriminator shared by SDK callers and CLI error envelopes. */
    readonly code: "invalid_unicode_output";
    /** Public-safe next step that never echoes the colliding key values. */
    readonly remedy = "Make object keys distinct after replacing lone UTF-16 surrogates with U+FFFD; values are replaced without changing valid Unicode.";
    /** Keep the refusal typed, public-safe and independent of tracker values. */
    constructor();
}
/** Normalize JSON-shaped output without mutating native records or historical digest inputs. */
export declare function normalizeUnicodeOutput<T>(value: T): T;
/** Shared JSON wire policy: replacement occurs only at the public output boundary. */
export declare function stringifyUnicodeOutput(value: unknown, space?: number): string | undefined;
/** Keep TOON and JSON text policy identical, including dynamic object keys. */
export declare function encodeUnicodeOutput(value: unknown): string;
//# sourceMappingURL=output-unicode.d.ts.map