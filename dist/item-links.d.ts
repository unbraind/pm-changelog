import type { PmItem } from "./types.ts";
/** Retain built-in links for standalone JSON, including legacy untyped rows. */
export declare function builtinItemFolder(type: string | undefined): string | undefined;
/** Resolve custom folders only from registry metadata; never pluralize a type. */
export declare function resolveItemFolder(item: PmItem, folders?: Readonly<Record<string, string>>): string;
/**
 * Yield every `](target)` link target in one linear pass.
 *
 * Equivalent to matching `/\]\(([^)\s]+)\)/g`, which CodeQL flags as polynomial
 * on untrusted input such as many repetitions of `](!`. When a scan stops at
 * whitespace or the end of input, every `](` inside the scanned span would stop
 * at the same character, so resuming there loses no match and keeps the work
 * linear.
 *
 * @param markdown - Rendered changelog markdown.
 * @returns Link targets in document order.
 */
export declare function markdownLinkTargets(markdown: string): Generator<string>;
/** Fail if a tracker link is absent, is a directory, or escapes the pm root, including symlinks. */
export declare function checkItemLinks(markdown: string, pmRoot: string, itemUrlBase: string): void;
//# sourceMappingURL=item-links.d.ts.map