/**
 * OpenUI Lang 1.0 only materializes literal `$variable` defaults. A computed
 * default (`$monthly = @Payment(...)`, `$n = $years * 12`) parses without an
 * error, but the store is seeded with the raw expression node, so the value
 * never computes and shows as 0 or `[object Object]`. The parser's
 * `stateDeclarations` keeps that node, which is how it is recognized here.
 */

// Expression kinds of lang-core's ASTNode that can survive materialization.
// Literals (Str, Num, Bool, Null, Arr, Obj) arrive as plain values instead.
const EXPRESSION_KINDS = new Set([
  "Comp",
  "Ref",
  "StateRef",
  "RuntimeRef",
  "BinOp",
  "UnaryOp",
  "Ternary",
  "Member",
  "Index",
  "Assign",
]);

function isExpressionNode(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = (value as { k?: unknown }).k;
  return typeof kind === "string" && EXPRESSION_KINDS.has(kind);
}

/** True for an expression node, or an array / object literal holding one (`[$a * 2, 1]`). */
function containsExpression(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 32) return false;
  if (isExpressionNode(value)) return true;
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.some((item) => containsExpression(item, depth + 1));
}

/**
 * Names of `$variables` whose declared default is an expression rather than a
 * literal, including array / object literals with expressions inside.
 */
export function computedStateNames(
  stateDeclarations: Record<string, unknown> | undefined,
): string[] {
  return Object.entries(stateDeclarations ?? {})
    .filter(([, value]) => containsExpression(value))
    .map(([name]) => name);
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

const MAX_REPAIR_PASSES = 3;

/**
 * Turns `$x = <expression>` declarations into plain derived values
 * (`x = <expression>`) so they compute, the way the prompt asks models to
 * write them. Only names the parser reports as computed are touched; the
 * user-editable `$variables` keep their names, so saved block state still
 * applies. Returns the program unchanged when there is nothing to repair.
 */
export function repairComputedState(
  source: string,
  parse: (source: string) => { stateDeclarations?: Record<string, unknown> } | null,
): string {
  let current = source;
  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
    const computed = computedStateNames(parse(current)?.stateDeclarations);
    if (computed.length === 0) break;
    const next = renameStateRefs(current, computed);
    if (next === current) break;
    current = next;
  }
  return current;
}
