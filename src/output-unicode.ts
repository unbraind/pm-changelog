import { encode } from "@toon-format/toon";
import { EXIT_CODE, PmCliError } from "@unbrained/pm-cli/sdk";
import { toUSVString } from "node:util";

/** A stable remedy avoids repeating or exposing attacker-controlled keys. */
const UNICODE_REMEDY = "Make object keys distinct after replacing lone UTF-16 surrogates with U+FFFD; values are replaced without changing valid Unicode.";

/** Replace only lone UTF-16 code units; valid pairs, whitespace and controls remain exact. */
export function normalizeUnicodeText(value: string): string {
  return toUSVString(value);
}

/** Refuse ambiguous dynamic keys instead of silently dropping a legacy field. */
export class UnicodeOutputError extends PmCliError {
  /** Stable discriminator shared by SDK callers and CLI error envelopes. */
  declare readonly code: "invalid_unicode_output";
  /** Public-safe next step that never echoes the colliding key values. */
  readonly remedy = UNICODE_REMEDY;
  /** Keep the refusal typed, public-safe and independent of tracker values. */
  constructor() { super("invalid_unicode_output: object key collision after Unicode replacement", EXIT_CODE.USAGE, { code: "invalid_unicode_output", field: "object key", nextSteps: [UNICODE_REMEDY] }); }
}

/** Normalize JSON-shaped output without mutating native records or historical digest inputs. */
export function normalizeUnicodeOutput<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") return normalizeUnicodeText(entry);
    if (!entry || typeof entry !== "object") return entry;
    if (seen.has(entry)) return seen.get(entry);
    if ("toJSON" in entry && typeof entry.toJSON === "function") {
      const projected: unknown = entry.toJSON();
      if (projected !== entry) return visit(projected);
    }
    if (entry instanceof Map) {
      const copy = new Map<string, unknown>(); seen.set(entry, copy);
      for (const [key, item] of entry) {
        const normalized = normalizeUnicodeText(String(key));
        if (copy.has(normalized)) throw new UnicodeOutputError();
        copy.set(normalized, visit(item));
      }
      return copy;
    }
    if (entry instanceof Set) {
      const copy = new Set<unknown>(); seen.set(entry, copy);
      for (const item of entry) copy.add(visit(item));
      return copy;
    }
    if (Array.isArray(entry)) {
      const copy: unknown[] = []; seen.set(entry, copy);
      for (let index = 0; index < entry.length; index++) if (Object.hasOwn(entry, index)) copy[index] = visit(entry[index]);
      copy.length = entry.length; return copy;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(entry))) return entry;
    const copy: Record<string, unknown> = {}; seen.set(entry, copy);
    for (const [key, item] of Object.entries(entry)) {
      const normalized = normalizeUnicodeText(key);
      if (Object.hasOwn(copy, normalized)) throw new UnicodeOutputError();
      Object.defineProperty(copy, normalized, { value: visit(item), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  };
  return visit(value) as T;
}

/** Shared JSON wire policy: replacement occurs only at the public output boundary. */
export function stringifyUnicodeOutput(value: unknown, space?: number): string | undefined {
  return JSON.stringify(normalizeUnicodeOutput(value), undefined, space);
}

/** Keep TOON and JSON text policy identical, including dynamic object keys. */
export function encodeUnicodeOutput(value: unknown): string {
  return encode(normalizeUnicodeOutput(value));
}
