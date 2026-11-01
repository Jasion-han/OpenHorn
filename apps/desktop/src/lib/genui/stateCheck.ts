/**
 * OpenUI Lang 1.0 only materializes literal `$variable` defaults. A computed
 * default (`$monthly = @Payment(...)`, `$n = $years * 12`) parses without an
 * error, but the store is seeded with the raw expression node, so the value
 * never computes and shows as 0 or `[object Object]`. Read the source AST
 * before materialization so arbitrary literal business objects stay untouched.
 */

import { type ASTNode, parseExpression, split, tokenize } from "@openuidev/lang-core";

/** Literal syntax is identified before materialization; business objects can have any keys. */
function isLiteral(node: ASTNode): boolean {
  switch (node.k) {
    case "Str":
    case "Num":
    case "Bool":
    case "Null":
      return true;
    case "Arr":
      return node.els.every(isLiteral);
    case "Obj":
      return node.entries.every(([, value]) => isLiteral(value));
    case "UnaryOp":
      // Lang-core materializes negative numeric defaults as numbers.
      return node.op === "-" && node.operand.k === "Num";
    default:
      return false;
  }
}

/** Names of state declarations whose SOURCE contains an expression, including nested values. */
export function computedStateNames(source: string): string[] {
  return split(tokenize(source))
    .filter((statement) => statement.id.startsWith("$"))
    .filter((statement) => !isLiteral(parseExpression(statement.tokens)))
    .map((statement) => statement.id);
}

const LITERAL_KEYWORDS = ["true", "false", "null"];
const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

/**
 * Walks `source` the way lang-core's lexer sees it: string literals (both
 * quote styles, backslash escapes, may span lines) and `//` / `#` line
 * comments are passed through untouched; `visit` gets every identifier
 * outside them (a `$name` arrives with its `$`) and returns its replacement.
 */
function mapIdentifiers(source: string, visit: (name: string, end: number) => string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i] as string;
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < n && source[i] !== c) i += source[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, n);
      out += source.slice(start, i);
      continue;
    }
    if ((c === "/" && source[i + 1] === "/") || c === "#") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += source.slice(i, stop);
      i = stop;
      continue;
    }
    const isState = c === "$" && IDENT_START.test(source[i + 1] ?? "");
    if (isState || IDENT_START.test(c)) {
      const start = i;
      i++;
      while (i < n && IDENT_CHAR.test(source[i] as string)) i++;
      out += visit(source.slice(start, i), i);
      continue;
    }
    if (/[0-9]/.test(c)) {
      // A number's exponent or digits must not start an identifier (`1e5`).
      const start = i;
      while (i < n && IDENT_CHAR.test(source[i] as string)) i++;
      out += source.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Plain names declared as statements (`name = ...`), outside strings and comments. */
function declaredNames(source: string): Set<string> {
  const names = new Set<string>();
  mapIdentifiers(source, (name, end) => {
    if (!name.startsWith("$")) {
      const rest = source.slice(end).match(/^[ \t]*=(.?)/);
      if (rest && rest[1] !== "=") names.add(name);
    }
    return name;
  });
  return names;
}

/**
 * Rewrites every `$name` in `names` to a plain name (`$months` → `months`),
 * leaving strings, comments and longer names (`$rate` for `$r`) alone. A plain
 * name already declared in the program gets a suffix instead (`months_`).
 */
export function renameStateRefs(source: string, names: readonly string[]): string {
  if (names.length === 0) return source;
  const taken = declaredNames(source);
  // `$true` → `true` would lex as a literal, not a name.
  for (const keyword of LITERAL_KEYWORDS) taken.add(keyword);
  const renames = new Map<string, string>();
  for (const name of names) {
    let base = name.slice(1);
    // An upper-case name would lex as a component type.
    base = (base[0] ?? "").toLowerCase() + base.slice(1);
    let plain = base;
    while (taken.has(plain)) plain += "_";
    taken.add(plain);
    renames.set(name, plain);
  }
  return mapIdentifiers(source, (name) => renames.get(name) ?? name);
}

/**
 * Computed declarations become plain derived values. Source ASTs distinguish an
 * expression from literal application data such as `{k: "Ref", name: "one"}`.
 * Only the render copy changes; stored model output and editable defaults stay intact.
 */
export function repairComputedState(source: string): string {
  return renameStateRefs(source, computedStateNames(source));
}

/** OpenUI expects a single root element; a root sequence needs the library's Col. */
export function wrapSequenceRoot(source: string): string {
  const statements = split(tokenize(source));
  const root = statements.find((statement) => statement.id === "root");
  if (!root) return source;
  const seen = new Set<string>();
  const isSequence = (expression: ASTNode): boolean => {
    if (expression.k === "Arr" || (expression.k === "Comp" && expression.name === "Each")) {
      return true;
    }
    if (expression.k === "Ternary")
      return isSequence(expression.then) || isSequence(expression.else);
    if (expression.k !== "Ref" || seen.has(expression.n)) return false;
    seen.add(expression.n);
    const target = statements.find((statement) => statement.id === expression.n);
    return target ? isSequence(parseExpression(target.tokens)) : false;
  };
  if (!isSequence(parseExpression(root.tokens))) return source;
  const taken = declaredNames(source);
  let name = "genUiRoot";
  while (taken.has(name)) name += "_";
  const renamed = mapIdentifiers(source, (identifier, end) =>
    identifier === "root" && /^[ \t]*=(?!=)/.test(source.slice(end)) ? name : identifier,
  );
  return `${renamed}\nroot = Col([${name}])`;
}
