import { compareVersionStrings } from "./generator.ts";

/** Canonical stable numeric release identity; unknown legacy headings remain unclassified. */
export function parseContractRelease(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 80 || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(0|[1-9]\d*))?$/.test(value)
    || value.replace(/^v/, "").split(/[.-]/).some((part) => !Number.isSafeInteger(Number(part)))) return undefined;
  return value.replace(/^v/, "");
}

/** Exclude known future releases before interpreting facets; unknown headings keep legacy handling. */
export function isContractReleaseAfter(value: unknown, upper: string): boolean {
  const release = parseContractRelease(value);
  return release !== undefined && compareVersionStrings(release, upper) > 0;
}
