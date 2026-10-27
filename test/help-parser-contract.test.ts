import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript5";

import { cliTestSurface } from "../src/cli.ts";

interface ParserFlag {
  name: string;
  takesValue: boolean;
}

/** Read parser syntax independently of help text and option suggestion lists. */
function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
}

/** Collect matching syntax nodes without depending on source formatting. */
function collect<T extends ts.Node>(root: ts.Node, guard: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  /** Visit each descendant exactly once. */
  function visit(node: ts.Node): void {
    if (guard(node)) result.push(node);
    ts.forEachChild(node, visit);
  }
  visit(root);
  return result;
}

/** Locate an actual parser declaration, failing when its implementation changes. */
function declaration(source: ts.SourceFile, name: string): ts.Node {
  const found = collect(source, ts.isVariableDeclaration).find((node) => node.name.getText(source) === name)
    ?? collect(source, ts.isFunctionDeclaration).find((node) => node.name?.text === name);
  assert.ok(found, `missing parser declaration ${name}`);
  return found;
}

/** Inventory switch cases plus normalization aliases, including short spellings. */
function rootParserFlags(source: ts.SourceFile): ParserFlag[] {
  const values = new Set(collect(declaration(source, "VALUE_OPTIONS"), ts.isStringLiteral).map((node) => node.text));
  const cases = collect(declaration(source, "parseArgs"), ts.isCaseClause).map((node) => {
    assert.ok(ts.isStringLiteral(node.expression));
    return node.expression.text;
  });
  const aliases = collect(declaration(source, "OPTION_ALIASES"), ts.isPropertyAssignment).map((node) => {
    assert.ok(ts.isStringLiteral(node.name));
    return node.name.text;
  });
  return [...cases, ...aliases].map((name) => ({ name, takesValue: values.has(name) }));
}

/** Inventory node:util parser options and their short aliases from its actual call. */
function subcommandParserFlags(path: string): ParserFlag[] {
  const source = sourceFile(path);
  const call = collect(source, ts.isCallExpression).find((node) => node.expression.getText(source) === "parseArgs");
  assert.ok(call, `${path} must call the strict parser`);
  const options = collect(call, ts.isPropertyAssignment).find((node) => node.name.getText(source) === "options");
  assert.ok(options && ts.isObjectLiteralExpression(options.initializer));
  return options.initializer.properties.flatMap((option) => {
    assert.ok(ts.isPropertyAssignment(option) && ts.isObjectLiteralExpression(option.initializer));
    const name = ts.isStringLiteral(option.name) ? option.name.text : option.name.getText(source);
    const properties = collect(option.initializer, ts.isPropertyAssignment);
    const type = properties.find((property) => property.name.getText(source) === "type");
    assert.ok(type && ts.isStringLiteral(type.initializer));
    const takesValue = type.initializer.text === "string";
    const flags = [{ name: `--${name}`, takesValue }];
    const short = properties.find((property) => property.name.getText(source) === "short");
    if (short) {
      assert.ok(ts.isStringLiteral(short.initializer));
      flags.push({ name: `-${short.initializer.text}`, takesValue });
    }
    return flags;
  });
}

/** Extract every flag spelling, including aliases and indented continuation lines. */
function advertisedFlags(help: string): string[] {
  return [...new Set(help.match(/(?<![\w-])--[a-z][a-z-]*\b|(?<![\w-])-[a-z]\b/g))].sort();
}

/** Give enum and numeric options valid parser values; other text needs no I/O. */
function argumentsFor(flag: ParserFlag): string[] {
  const samples: Record<string, string> = {
    "--group-by": "version", "--section-by": "category", "--entry-from": "title",
    "--format": "json", "--mode": "replace", "--item-ref-style": "auto",
    "--limit": "1", "--body-preview": "1",
  };
  return flag.takesValue ? [flag.name, samples[flag.name] ?? "value"] : [flag.name];
}

const rootSource = sourceFile("../src/cli.ts");
const rootFlags = rootParserFlags(rootSource);
const commands = new Map<string, ParserFlag[]>([
  ["", rootFlags], ["audit", rootFlags],
  ["contracts", subcommandParserFlags("../src/audience-command.ts")],
  ["upgrades", subcommandParserFlags("../src/consumer-upgrade-command.ts")],
  ["corrections", subcommandParserFlags("../src/release-correction-command.ts")],
]);

test("help contract covers every standalone command dispatched by main", () => {
  const dispatched = collect(declaration(rootSource, "main"), ts.isBinaryExpression)
    .filter((node) => node.left.getText(rootSource) === "args[0]" && ts.isStringLiteral(node.right))
    .map((node) => (node.right as ts.StringLiteral).text);
  assert.deepEqual([...commands.keys()].filter(Boolean).sort(), dispatched.sort());
});

for (const command of ["contracts", "upgrades"]) {
  test(`root ${command} synopsis documents exactly that command's flags`, (t) => {
    const writes: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    cliTestSurface.printHelp();
    // A continuation belongs to the preceding command; keep it in the match
    // so moving grouping flags under upgrades fails independently of Options.
    const summaries = [...writes.join("").matchAll(/^  (contracts|upgrades) .*(?:\n {4,}.*)*/gm)];
    const summary = summaries.find((match) => match[1] === command);
    assert.ok(summary, `${command} must have a root synopsis`);
    assert.deepEqual(advertisedFlags(summary[0]), commands.get(command)?.map((flag) => flag.name).sort());
  });
}

for (const [command, flags] of commands) {
  test(`${command || "root"} help documents exactly the flags its parser accepts`, async (t) => {
    const writes: string[] = [];
    const helpExit = new Error("help exit");
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    t.mock.method(process, "exit", (code?: number) => {
      assert.equal(code, 0);
      throw helpExit;
    });
    /** Run a help request while allowing the root parser's deliberate exit. */
    async function invoke(args: string[]): Promise<void> {
      try {
        await cliTestSurface.main(command ? [command, ...args] : args);
      } catch (error) {
        if (error !== helpExit) throw error;
      }
    }
    await invoke(["--help"]);
    const help = writes.join("");
    const expected = flags.map((flag) => flag.name).sort();
    const ownHelp = command === "" || command === "audit" ? help.split("Options:\n")[1]?.split("\nValue flags")[0] : help;
    assert.ok(ownHelp, "command help must contain its option documentation");
    assert.deepEqual(advertisedFlags(ownHelp), expected, "advertised and parsed flag spellings must match in both directions");

    for (const flag of flags) {
      writes.length = 0;
      // Root parsing is tested without a trailing help exit, so a silently
      // ignored or invalid value cannot hide behind the usage path.
      if (!command || command === "audit") {
        if (flag.name === "--help" || flag.name === "-h") await invoke([flag.name]);
        else assert.doesNotThrow(() => cliTestSurface.parseArgs(argumentsFor(flag)), flag.name);
      } else {
        await invoke([...argumentsFor(flag), "--help"]);
      }
    }
    await assert.rejects(invoke(["--help-contract-unknown", "--help"]), /Unknown option|invalid_contract_options|invalid_upgrade_options|Run pm-changelog/);
  });
}
