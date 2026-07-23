import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";

export type SourceFile = { readonly path: string; readonly content: string };
export type Violation = {
  readonly file: string;
  readonly line: number;
  readonly table: string;
  readonly method: string;
  readonly snippet: string;
};

const TABLE_DECL = /\.table\s*\(\s*["'`]([^"'`]+)["'`]/g;
// High-confidence direct write: ctx.db.insert("<table>", …). `insert` is the only
// db write that names the table as a string literal; patch/delete/replace take a
// document id (covered by the AST pass below). Tolerates whitespace/newlines.
const DIRECT_INSERT = /ctx\s*\.\s*db\s*\.\s*(insert)\s*\(\s*["'`]([^"'`]+)["'`]/g;

/** Collect table names declared local-first via the DSL (`lf.table("name", ...)`). */
export function collectLocalFirstTables(files: readonly SourceFile[]): string[] {
  const tables = new Set<string>();
  for (const file of files) {
    for (const match of file.content.matchAll(TABLE_DECL)) {
      tables.add(match[1]);
    }
  }
  return [...tables];
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/**
 * Detect direct `ctx.db.insert("<lfTable>", …)` calls — writes that bypass the
 * local-first wrappers and the sync ledger (Security: I10).
 */
export function findDirectWrites(
  files: readonly SourceFile[],
  lfTables: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  const lfSet = new Set(lfTables);
  for (const file of files) {
    for (const match of file.content.matchAll(DIRECT_INSERT)) {
      const [, method, table] = match;
      if (lfSet.has(table)) {
        const line = lineOf(file.content, match.index ?? 0);
        violations.push({
          file: file.path,
          line,
          table,
          method,
          snippet: file.content.split("\n")[line - 1]?.trim() ?? "",
        });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// AST pass: id-based writes (ctx.db.patch/delete/replace) to local-first rows.
//
// patch/delete/replace take a document id, not a table literal, so they can't be
// matched by regex. This pass tracks, *within a single function*, ids that
// provably come from a local-first table and flags writes that use them. It is
// SOUND by construction — it only flags when it can see the id's origin, so a
// clean result over recognized patterns is real (no false positives). It does
// NOT trace ids across function boundaries or through ctx.db.get(); those stay
// unflagged (false negatives), same coverage class as before but strictly more.
//
// Syntactic, function-scoped taint over `const`/handler-args only —
// no type checker, no cross-call dataflow. Upgrade path: a full ts.Program +
// TypeChecker pass if cross-function id passing shows up as a real miss.
// ---------------------------------------------------------------------------

const ID_WRITE_METHODS = new Set(["patch", "delete", "replace"]);

type Scope = {
  /** const var name -> lf table, when the var holds a doc from that table */
  readonly constDoc: Map<string, string>;
  /** handler's `args` param identifier name, if any */
  argParam?: string;
  /** args field name -> lf table, from `v.id("lf")` validators */
  readonly argTaint: Map<string, string>;
  /** destructured arg id binding name -> lf table (handler `({ id })`) */
  readonly destructuredIds: Map<string, string>;
};

function freshScope(): Scope {
  return { constDoc: new Map(), argTaint: new Map(), destructuredIds: new Map() };
}

function unwrap(node: ts.Expression): ts.Expression {
  if (
    ts.isAwaitExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return unwrap(node.expression);
  }
  return node;
}

/** `ctx.db.<method>`? Returns the method name. Hardcodes the `ctx.db` convention. */
function ctxDbMethod(callee: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const obj = callee.expression;
  if (
    ts.isPropertyAccessExpression(obj) &&
    obj.name.text === "db" &&
    ts.isIdentifier(obj.expression) &&
    obj.expression.text === "ctx"
  ) {
    return callee.name.text;
  }
  return undefined;
}

/** Walk a query chain down to `ctx.db.query("X")`; return X if it is an lf table. */
function queryRootTable(expr: ts.Expression, lfSet: Set<string>): string | undefined {
  let cur: ts.Node = expr;
  for (;;) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (ts.isPropertyAccessExpression(callee) && ctxDbMethod(callee) === "query") {
        const arg = cur.arguments[0];
        if (arg && ts.isStringLiteralLike(arg) && lfSet.has(arg.text)) return arg.text;
        return undefined;
      }
      cur = callee;
    } else if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else {
      return undefined;
    }
  }
}

/** A single-doc query (`…first()`/`…unique()`) rooted at an lf table -> the table. */
function singleDocQueryTable(expr: ts.Expression, lfSet: Set<string>): string | undefined {
  const e = unwrap(expr);
  if (!ts.isCallExpression(e)) return undefined;
  const callee = e.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  if (callee.name.text !== "first" && callee.name.text !== "unique") return undefined;
  return queryRootTable(callee.expression, lfSet);
}

/** Classify the id argument of a patch/delete/replace call -> lf table, or undefined. */
function classifyId(arg: ts.Expression, scope: Scope, lfSet: Set<string>): string | undefined {
  const a = unwrap(arg);
  if (ts.isPropertyAccessExpression(a)) {
    const base = a.expression;
    if (a.name.text === "_id") {
      // <constDoc>._id  or  (await ctx.db.query("lf")…first())._id
      if (ts.isIdentifier(base) && scope.constDoc.has(base.text))
        return scope.constDoc.get(base.text);
      const inline = singleDocQueryTable(base, lfSet);
      if (inline) return inline;
    } else if (ts.isIdentifier(base) && base.text === scope.argParam) {
      // args.<field> where field is a v.id("lf") validator
      return scope.argTaint.get(a.name.text);
    }
  } else if (ts.isIdentifier(a)) {
    // handler destructured `({ id })` where id is a v.id("lf") validator
    return scope.destructuredIds.get(a.text);
  }
  return undefined;
}

/** Extract field -> lf table from an `args: { f: v.id("lf") }` validator object. */
function readArgValidators(
  argsValue: ts.Expression,
  lfSet: Set<string>,
  out: Map<string, string>,
): void {
  if (!ts.isObjectLiteralExpression(argsValue)) return;
  for (const prop of argsValue.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = prop.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
    const field = name.text;
    const call = prop.initializer;
    // v.id("lf")  — PropertyAccess `.id` called with a single string literal.
    if (
      ts.isCallExpression(call) &&
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === "id"
    ) {
      const tbl = call.arguments[0];
      if (tbl && ts.isStringLiteralLike(tbl) && lfSet.has(tbl.text)) out.set(field, tbl.text);
    }
  }
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function findIdBasedWrites(
  files: readonly SourceFile[],
  lfTables: readonly string[],
): Violation[] {
  const lfSet = new Set(lfTables);
  if (lfSet.size === 0) return [];
  const violations: Violation[] = [];

  for (const file of files) {
    const sf = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKindFor(file.path),
    );

    const record = (node: ts.Node, table: string, method: string) => {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      violations.push({
        file: file.path,
        line,
        table,
        method,
        snippet: file.content.split("\n")[line - 1]?.trim() ?? "",
      });
    };

    const visit = (node: ts.Node, scope: Scope): void => {
      // Convex function definition shape: someWrapper({ args?, handler }).
      if (ts.isCallExpression(node) && node.arguments.length === 1) {
        const arg0 = node.arguments[0];
        if (ts.isObjectLiteralExpression(arg0)) {
          const handlerProp = arg0.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === "handler" &&
              (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)),
          );
          if (handlerProp) {
            const handlerScope = freshScope();
            const argsProp = arg0.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "args",
            );
            if (argsProp) readArgValidators(argsProp.initializer, lfSet, handlerScope.argTaint);

            const handler = handlerProp.initializer as ts.ArrowFunction | ts.FunctionExpression;
            const argsParam = handler.parameters[1];
            if (argsParam) {
              if (ts.isIdentifier(argsParam.name)) {
                handlerScope.argParam = argsParam.name.text;
              } else if (ts.isObjectBindingPattern(argsParam.name)) {
                for (const el of argsParam.name.elements) {
                  if (!ts.isIdentifier(el.name)) continue;
                  const field =
                    el.propertyName && ts.isIdentifier(el.propertyName)
                      ? el.propertyName.text
                      : el.name.text;
                  const tbl = handlerScope.argTaint.get(field);
                  if (tbl) handlerScope.destructuredIds.set(el.name.text, tbl);
                }
              }
            }
            // Visit the handler body in its own scope; visit the rest (incl. the
            // args validators) in the outer scope.
            if (handler.body) visit(handler.body, handlerScope);
            for (const prop of arg0.properties) {
              if (prop !== handlerProp) visit(prop, scope);
            }
            return;
          }
        }
      }

      // `const x = await ctx.db.query("lf")…first()/.unique()` taints x as a doc.
      if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const tbl = singleDocQueryTable(decl.initializer, lfSet);
            if (tbl) scope.constDoc.set(decl.name.text, tbl);
          }
        }
      }

      // ctx.db.patch/delete/replace(<id>, …)
      if (ts.isCallExpression(node)) {
        const method = ctxDbMethod(node.expression);
        if (method && ID_WRITE_METHODS.has(method) && node.arguments[0]) {
          const tbl = classifyId(node.arguments[0], scope, lfSet);
          if (tbl) record(node, tbl, method);
        }
      }

      node.forEachChild((child) => visit(child, scope));
    };

    visit(sf, freshScope());
  }

  return violations;
}

function readSourceFiles(dir: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "_generated" || entry === "dist") {
        continue;
      }
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        files.push({ path: full, content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return files;
}

/** Run the full check over a directory. Returns violations (empty = clean). */
export function runCheck(dir: string): Violation[] {
  const files = readSourceFiles(dir);
  const lfTables = collectLocalFirstTables(files);
  return [...findDirectWrites(files, lfTables), ...findIdBasedWrites(files, lfTables)];
}
