#!/usr/bin/env node
/**
 * Fail the build when a documented-surface declaration lacks a real docstring.
 *
 * The repo-wide mandate requires full docstring coverage, but a naive
 * implementation of that rule is trivially satisfied and therefore worse than
 * no gate at all - it produces a green check that proves nothing. This gate is
 * built against four specific ways such a check gets defeated:
 *
 * 1. **Text scanning counts the wrong bytes.** A JSDoc-like sequence inside a
 *    string, a template literal, or a commented-out declaration satisfies a
 *    textual match, and a brace inside any of those corrupts the nesting
 *    arithmetic that decides what is a class member. This gate parses each file
 *    into a real syntax tree and inspects declarations, so only genuine
 *    declarations are checked and only genuinely attached JSDoc counts.
 * 2. **A docstring that restates the identifier.** {@link addsInformation}
 *    reduces the identifier and the comment to word sets and requires the
 *    comment to contribute terms the identifier did not already carry, so
 *    `Gets the name` on `getName()` fails.
 * 3. **A frozen file list.** Any config enumerating the files to scan silently
 *    stops covering whatever is added later. This walks the configured roots,
 *    so a new file is covered the moment it exists, and there is deliberately
 *    no ignore list.
 * 4. **Vacuous success.** A gate that passes because it found nothing is the
 *    most expensive kind of green. A requested root that does not exist, and a
 *    root set that yields no files, both fail.
 *
 * Scope - what must be documented:
 *   - every exported declaration: `function`, `class`, `interface`, `type`,
 *     `enum`, `const`, `let`, `var`;
 *   - every non-private member of an exported class, including accessors and a
 *     declared constructor;
 *   - every function declaration, exported or not, whose body exceeds
 *     {@link INTERNAL_BODY_LINES} lines.
 *
 * Deliberately out of scope, each because the documentation belongs elsewhere:
 * overload signatures (the implementation carries it), re-exports such as
 * `export { x }` / `export * from` / `export type { T }` (the original
 * declaration is the documented one), and destructuring declarations, which
 * bind no single documentable name.
 *
 * ### Why this parses with `typescript5` rather than the installed `typescript`
 *
 * TypeScript 7 removed the stable compiler API: `createSourceFile`,
 * `forEachChild`, and `ScriptTarget` are absent at runtime while still
 * type-checking, and its `unstable/*` replacements are either a raw lexer that
 * the consumer must drive through template and regular-expression rescanning,
 * or a project API that needs a live native language-server session. Neither is
 * appropriate for a standalone, cross-platform gate, so the parse is pinned to
 * a `typescript@5` alias devDependency. It is pure JavaScript, so it runs
 * unchanged on the Windows CI legs.
 *
 * This script scans itself: `scripts` is one of the default roots.
 *
 * @example
 * ```bash
 * node scripts/docstring-gate.ts          # scan the default roots
 * node scripts/docstring-gate.ts src      # scan only src/
 * ```
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript5";

/** Directories walked for source files when no roots are given on argv. */
const DEFAULT_ROOTS = ["src", "scripts"];

/** Minimum meaningful words a docstring must contain. */
const MIN_DOC_WORDS = 4;

/** Novel words a docstring must contribute beyond the identifier's own words. */
const MIN_NOVEL_WORDS = 2;

/** Body lines above which any function declaration needs a docstring. */
const INTERNAL_BODY_LINES = 4;

/** Filler words stripped before comparing a docstring against its identifier. */
const FILLER = new Set([
  "a", "an", "the", "of", "for", "to", "from", "in", "on", "at", "by", "with",
  "and", "or", "is", "are", "was", "be", "been", "this", "that", "these", "those",
  "it", "its", "as", "get", "gets", "set", "sets", "return", "returns", "returned",
  "value", "values", "given", "used", "use", "uses", "when", "if", "then", "into",
  "via", "per", "not", "may", "can", "will", "has", "have", "had", "does", "do",
  "making", "make", "called", "call", "calls",
  "whether", "while", "which", "what", "where", "how", "why",
  "both", "each", "all", "any", "some", "no", "nor", "none", "either", "neither",
  "also", "always", "never", "often", "usually", "typically", "generally",
  "respectively", "eg", "ie",
]);

/** A single gate violation, reported as an actionable source location. */
interface Violation {
  /** Repo-relative path of the offending file. */
  readonly file: string;
  /** 1-based line of the offending declaration. */
  readonly line: number;
  /** Declared name, qualified as `Class.member` for class members. */
  readonly symbol: string;
  /** Why the declaration failed. */
  readonly reason: string;
}

/** Collect every non-declaration `.ts` file beneath a directory. */
function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full));
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) found.push(full);
  }
  return found;
}

/** Split text into lowercased, content-bearing words, splitting camelCase. */
function toWords(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 1 && !FILLER.has(word));
}

/** True when a docstring contributes terms beyond those already in the name. */
function addsInformation(docText: string, symbol: string): boolean {
  const docWords = toWords(docText);
  if (docWords.length < MIN_DOC_WORDS) return false;
  const nameWords = new Set(toWords(symbol));
  const novel = new Set(docWords.filter((word) => !nameWords.has(word)));
  return novel.size >= MIN_NOVEL_WORDS;
}

/**
 * Recover the JSDoc block attached immediately before a declaration.
 *
 * Reads the node's own leading trivia rather than asking the compiler for
 * inherited documentation, so a documented enclosing statement can never
 * satisfy an undocumented declaration inside it. Only the last leading comment
 * counts, so an unrelated file banner cannot stand in for a missing docstring,
 * and `/* *\/` blocks are rejected because JSDoc requires a `/**` opener.
 */
function jsdocFor(node: ts.Node, text: string): string {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart());
  if (!ranges || ranges.length === 0) return "";
  const last = ranges[ranges.length - 1];
  if (last.kind !== ts.SyntaxKind.MultiLineCommentTrivia) return "";
  const raw = text.slice(last.pos, last.end);
  if (!raw.startsWith("/**")) return "";
  return raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** True when a declaration carries an `export` modifier. */
function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

/** Declaration name as written, or `undefined` for computed and unnamed ones. */
function declaredName(node: ts.Node): string | undefined {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const named = node as { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  return undefined;
}

/**
 * Resolve the docstring that documents a function-like declaration.
 *
 * TypeScript's convention places an overload set's documentation on a signature
 * rather than on the implementation - that is what editors surface - so the set
 * is treated as one documented unit and the first docstring found among its
 * members counts for all of them. Without this the gate would demand the
 * docstring on the implementation specifically and reject idiomatic code.
 */
function effectiveDoc(node: ts.Node, text: string): string {
  const own = jsdocFor(node, text);
  if (own) return own;
  const name = declaredName(node);
  const parent = node.parent;
  if (!name || !parent) return "";
  const siblings: readonly ts.Node[] = ts.isClassDeclaration(parent)
    ? parent.members
    : ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent)
      ? parent.statements
      : [];
  for (const sibling of siblings) {
    if (sibling === node || sibling.kind !== node.kind) continue;
    if (declaredName(sibling) !== name) continue;
    const doc = jsdocFor(sibling, text);
    if (doc) return doc;
  }
  return "";
}

/** Append a violation when a declaration's docstring is missing or deficient. */
function judge(
  violations: Violation[],
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
  symbol: string,
  docText: string,
): void {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  if (!docText) {
    violations.push({ file, line, symbol, reason: "no docstring" });
    return;
  }
  const words = toWords(docText);
  if (words.length < MIN_DOC_WORDS) {
    violations.push({
      file,
      line,
      symbol,
      reason: `docstring under ${MIN_DOC_WORDS} meaningful words (got ${words.length})`,
    });
    return;
  }
  if (!addsInformation(docText, symbol)) {
    violations.push({
      file,
      line,
      symbol,
      reason: `docstring restates the identifier (needs ${MIN_NOVEL_WORDS}+ terms not in the name)`,
    });
  }
}

/** Interior line count of a function body, used for the internal-size rule. */
function bodyLineSpan(body: ts.Block, source: ts.SourceFile): number {
  const start = source.getLineAndCharacterOfPosition(body.getStart(source)).line;
  const end = source.getLineAndCharacterOfPosition(body.getEnd()).line;
  return end - start - 1;
}

/**
 * Check every non-private member of an exported class.
 *
 * Overload signatures are skipped because the implementation that follows them
 * carries the documentation, and `#private` names plus `private`/`protected`
 * members are outside the documented surface.
 */
function checkClassMembers(
  violations: Violation[],
  file: string,
  source: ts.SourceFile,
  text: string,
  cls: ts.ClassDeclaration,
): void {
  const className = cls.name?.text ?? "default";
  for (const member of cls.members) {
    const flags = ts.getCombinedModifierFlags(member);
    if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
    if (member.name && ts.isPrivateIdentifier(member.name)) continue;
    if (
      (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) &&
      member.body === undefined
    ) continue;
    if (
      !ts.isMethodDeclaration(member) &&
      !ts.isPropertyDeclaration(member) &&
      !ts.isGetAccessorDeclaration(member) &&
      !ts.isSetAccessorDeclaration(member) &&
      !ts.isConstructorDeclaration(member)
    ) continue;

    const memberName =
      declaredName(member) ?? member.name?.getText(source) ?? "<computed>";
    judge(
      violations,
      file,
      source,
      member,
      `${className}.${memberName}`,
      effectiveDoc(member, text),
    );
  }
}

/**
 * Report every documented-surface declaration in one file lacking a docstring.
 *
 * Recurses through the syntax tree so a function nested inside another function
 * is held to the same size rule as a top-level one.
 */
function scanFile(filePath: string, root: string): Violation[] {
  const violations: Violation[] = [];
  const text = readFileSync(filePath, "utf8");
  const file = relative(root, filePath);
  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      // A bodyless declaration is an overload signature; the implementation
      // that follows it is the one held to the rule.
      if (node.body) {
        const big = bodyLineSpan(node.body, source) > INTERNAL_BODY_LINES;
        if (isExported(node) || big) {
          judge(violations, file, source, node, node.name.text, effectiveDoc(node, text));
        }
      }
    } else if (ts.isClassDeclaration(node) && isExported(node)) {
      judge(violations, file, source, node, node.name?.text ?? "default", jsdocFor(node, text));
      checkClassMembers(violations, file, source, text, node);
    } else if (
      (ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      isExported(node)
    ) {
      judge(violations, file, source, node, node.name.text, jsdocFor(node, text));
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      // The JSDoc precedes the statement, not the individual declarator.
      const doc = jsdocFor(node, text);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        judge(violations, file, source, decl, decl.name.text, doc);
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return violations;
}

const repoRoot = process.cwd();
const argvRoots = process.argv.slice(2);
const roots = argvRoots.length > 0 ? argvRoots : DEFAULT_ROOTS;
const present = roots.filter((r) => existsSync(join(repoRoot, r)));

if (argvRoots.length > 0 && present.length !== roots.length) {
  const missing = roots.filter((r) => !present.includes(r));
  console.error(
    `docstring-gate: requested root(s) not found: ${missing.join(", ")} - refusing to pass vacuously.`,
  );
  process.exit(1);
}

const files = present.flatMap((r) => collectSourceFiles(join(repoRoot, r))).sort();

if (files.length === 0) {
  console.error(
    `docstring-gate: no source files found under ${roots.join(", ")} - refusing to pass vacuously.`,
  );
  process.exit(1);
}

const allViolations = files.flatMap((f) => scanFile(f, repoRoot));

if (allViolations.length > 0) {
  console.error(
    `\ndocstring-gate: ${allViolations.length} violation(s) across ${files.length} file(s):\n`,
  );
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.line}  ${v.symbol} - ${v.reason}`);
  }
  console.error(
    "\nEvery exported declaration, every non-private member of an exported" +
      `\nclass, and every function with a body over ${INTERNAL_BODY_LINES} lines needs a real` +
      "\ndocstring. Restating the identifier does not count.\n",
  );
  process.exit(1);
}

console.log(
  `docstring-gate: ${files.length} source file(s) scanned across ${present.join(", ")}; documented surface complete.`,
);
