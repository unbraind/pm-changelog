import type { PmItem } from "./types.ts";
/** Retain built-in links for standalone JSON, including legacy untyped rows. */
export declare function builtinItemFolder(type: string | undefined): string | undefined;
/** Resolve custom folders only from registry metadata; never pluralize a type. */
export declare function resolveItemFolder(item: PmItem, folders?: Readonly<Record<string, string>>): string;
/**
 * Yield `](target)` link targets, including optional CommonMark titles, in linear time.
 *
 * Destination scans resume at their stopping character. Title lookahead stops
 * at the next unescaped delimiter, including any later opener of the same style
 * (which follows whitespace and cannot be escaped). Lookahead spans therefore
 * do not overlap within a title style; the three styles bound total work to a
 * constant number of input passes. Failed titles resume at the destination end
 * to retain later links. Untitled links without whitespace keep the old behavior.
 *
 * @param markdown - Rendered changelog markdown.
 * @returns Link targets in document order.
 */
export declare function markdownLinkTargets(markdown: string): Generator<string>;
/** Fail if a tracker link is absent, is a directory, or escapes the pm root, including symlinks. */
export declare function checkItemLinks(markdown: string, pmRoot: string, itemUrlBase: string): void;
//# sourceMappingURL=item-links.d.ts.map