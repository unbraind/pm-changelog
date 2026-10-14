import type { PmItem } from "./types.ts";
/** Retain built-in links for standalone JSON, including legacy untyped rows. */
export declare function builtinItemFolder(type: string | undefined): string | undefined;
/** Resolve custom folders only from registry metadata; never pluralize a type. */
export declare function resolveItemFolder(item: PmItem, folders?: Readonly<Record<string, string>>): string;
/** Fail if a tracker link is absent, is a directory, or escapes the pm root, including symlinks. */
export declare function checkItemLinks(markdown: string, pmRoot: string, itemUrlBase: string): void;
//# sourceMappingURL=item-links.d.ts.map