/*

Lift Elm variant constructor functions to ES6 classes.

Elm emits variant constructors like:

  var $elm$core$Maybe$Just = function (a) { return { $: 0, a: a }; };
  var $Foo$Bar_fn = function (a, b) { return { $: 0, a: a, b: b }; };

These are functions that construct tagged objects. This transform detects
that pattern, emits a corresponding class, rewrites the function body to
delegate to the class (so indirect uses of the constructor as a value still
work), and rewrites direct call sites to skip the function entirely:

  var $$V0 = class { constructor(a) { this.$ = 0; this.a = a; } };
  var $elm$core$Maybe$Just = function (a) { return new $$V0(a); };
  // call site $elm$core$Maybe$Just(x)  →  new $$V0(x)

This is the same trick as inlineTuples, generalized to any variant
constructor. The goal is call-elimination at the direct-call sites;
hidden class unification is a secondary (and, per the tuples/records
experiments, apparently modest) benefit.

Soundness:
  - The function wrapper is preserved so `A2(List.map, $Just, xs)` still works.
  - The inner `new $$V0(a)` call produces an instance with the same hidden
    class as the direct call site, so both paths unify.
  - Class instances have `.$` as an own property (set in the constructor),
    so `_Utils_cmp` / `_Utils_eq` / pattern matching on `.$` work identically.
  - We skip detection when the param names don't map 1-to-1 with field
    initializers, which rules out things like `_List_Cons(hd, tl)` whose
    field initializers don't match param names.

Known non-targets:
  - Zero-arg variants like `var $Nothing = { $: 1, a: null }` are already
    singletons, not constructor functions. Nothing to do.
  - `_Utils_Tuple2/Tuple3` have no `$` field, so they're not matched here.
  - `_List_Cons` has `$: 1, a: hd, b: tl` where params are `hd, tl` — the
    field-name-to-param-name mismatch causes it to be skipped (and we
    already showed it doesn't benefit from classification anyway).

*/

import ts from 'typescript';

interface VariantCtor {
  /** The original identifier name, e.g., `$elm$core$Maybe$Just` */
  name: string;
  /** Generated class name, e.g., `$$V0` */
  className: string;
  /** Discriminant tag value (the `$` field) */
  tag: number;
  /** Field names in the order they appear in the object literal */
  fields: string[];
  /** Parameter name corresponding to each field */
  fieldParams: string[];
  /** The function's parameter names, in order */
  paramNames: string[];
}

export type InlineVariantCtorsMode = 'class' | 'literal';

export interface InlineVariantCtorsOptions {
  verbose?: boolean;
  /** 'class' uses ES6 classes, 'literal' uses plain object literals. */
  mode?: InlineVariantCtorsMode;
  /** If set, only transform the top N constructors by direct-call frequency. */
  topK?: number;
}

function detectVariant(decl: ts.VariableDeclaration): Omit<VariantCtor, 'className'> | null {
  if (!ts.isIdentifier(decl.name)) return null;
  const init = decl.initializer;
  if (!init || !ts.isFunctionExpression(init)) return null;

  // Collect parameter names
  const paramNames: string[] = [];
  for (const p of init.parameters) {
    if (!ts.isIdentifier(p.name)) return null;
    if (p.dotDotDotToken || p.questionToken || p.initializer) return null;
    paramNames.push(p.name.text);
  }
  if (paramNames.length === 0) return null;

  // Body must be a single return statement
  if (init.body.statements.length !== 1) return null;
  const ret = init.body.statements[0];
  if (!ts.isReturnStatement(ret) || !ret.expression) return null;

  // Return expression must be an object literal
  if (!ts.isObjectLiteralExpression(ret.expression)) return null;

  let tag: number | null = null;
  const fields: string[] = [];
  const fieldParams: string[] = [];

  for (const prop of ret.expression.properties) {
    if (!ts.isPropertyAssignment(prop)) return null;

    let name: string;
    if (ts.isIdentifier(prop.name)) {
      name = prop.name.text;
    } else if (ts.isStringLiteral(prop.name)) {
      name = prop.name.text;
    } else {
      return null;
    }

    if (name === '$') {
      // Discriminant must be a numeric literal.
      if (!ts.isNumericLiteral(prop.initializer)) return null;
      tag = Number(prop.initializer.text);
    } else {
      // Field initializer must be an identifier that names one of the
      // function parameters.
      if (!ts.isIdentifier(prop.initializer)) return null;
      if (!paramNames.includes(prop.initializer.text)) return null;
      fields.push(name);
      fieldParams.push(prop.initializer.text);
    }
  }

  if (tag === null) return null;
  if (fields.length === 0) return null;

  return {
    name: decl.name.text,
    tag,
    fields,
    fieldParams,
    paramNames,
  };
}

export const inlineVariantCtors = (
  options: InlineVariantCtorsOptions = {}
): ts.TransformerFactory<ts.SourceFile> => {
  const mode: InlineVariantCtorsMode = options.mode ?? 'class';

  return context => sourceFile => {
    // Pass 1: detect all variant constructors and count their direct call sites.
    const detected = new Map<string, Omit<VariantCtor, 'className'>>();
    const callCounts = new Map<string, number>();

    const collect = (node: ts.Node) => {
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          const d = detectVariant(decl);
          if (d) detected.set(d.name, d);
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        callCounts.set(name, (callCounts.get(name) || 0) + 1);
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);

    // If topK is set, only keep the K most-called constructors.
    let selected: Array<[string, Omit<VariantCtor, 'className'>]> = [...detected.entries()];
    if (options.topK !== undefined) {
      selected.sort((a, b) => (callCounts.get(b[0]) || 0) - (callCounts.get(a[0]) || 0));
      selected = selected.slice(0, options.topK);
    }

    const ctors = new Map<string, VariantCtor>();
    selected.forEach(([name, d], i) => {
      ctors.set(name, { ...d, className: `$$V${i}` });
    });

    if (options.verbose) {
      const totalCalls = [...ctors.keys()].reduce(
        (s, n) => s + (callCounts.get(n) || 0),
        0
      );
      console.log(
        `inlineVariantCtors: mode=${mode}, transforming ${ctors.size}/${detected.size} ` +
          `constructors covering ${totalCalls} direct call sites`
      );
    }

    if (ctors.size === 0) return sourceFile;

    const makeInstance = (ctor: VariantCtor, args: ts.Expression[]): ts.Expression => {
      if (mode === 'class') {
        return ts.factory.createNewExpression(
          ts.factory.createIdentifier(ctor.className),
          undefined,
          args
        );
      }
      // literal mode: { $: tag, field0: arg0, field1: arg1, ... }
      // We need to map fields to their corresponding arg positions.
      const props: ts.ObjectLiteralElementLike[] = [
        ts.factory.createPropertyAssignment(
          '$',
          ts.factory.createNumericLiteral(ctor.tag)
        ),
      ];
      for (let i = 0; i < ctor.fields.length; i++) {
        const paramIdx = ctor.paramNames.indexOf(ctor.fieldParams[i]);
        props.push(
          ts.factory.createPropertyAssignment(ctor.fields[i], args[paramIdx])
        );
      }
      return ts.factory.createObjectLiteralExpression(props);
    };

    // Pass 2: rewrite direct call sites (and, in class mode, the function bodies).
    const rewriteVisitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
      // Rewrite direct call sites.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const ctor = ctors.get(node.expression.text);
        if (ctor && node.arguments.length === ctor.paramNames.length) {
          const args = node.arguments.map(
            a => ts.visitNode(a, rewriteVisitor) as ts.Expression
          );
          return makeInstance(ctor, args);
        }
      }

      // In class mode, also rewrite the constructor function body so that
      // indirect uses (like `A2(List.map, $Just, xs)`) still land at the class
      // and unify hidden classes with direct-call sites.
      if (
        mode === 'class' &&
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name)
      ) {
        const ctor = ctors.get(node.name.text);
        if (ctor && node.initializer && ts.isFunctionExpression(node.initializer)) {
          const fn = node.initializer;
          const args = ctor.paramNames.map(p => ts.factory.createIdentifier(p));
          const newBody = ts.factory.createBlock(
            [
              ts.factory.createReturnStatement(
                ts.factory.createNewExpression(
                  ts.factory.createIdentifier(ctor.className),
                  undefined,
                  args
                )
              ),
            ],
            false
          );
          const newFn = ts.factory.createFunctionExpression(
            fn.modifiers,
            fn.asteriskToken,
            fn.name,
            fn.typeParameters,
            fn.parameters,
            fn.type,
            newBody
          );
          return ts.factory.updateVariableDeclaration(
            node,
            node.name,
            node.exclamationToken,
            node.type,
            newFn
          );
        }
      }

      return ts.visitEachChild(node, rewriteVisitor, context);
    };

    const transformed = ts.visitNode(sourceFile, rewriteVisitor) as ts.SourceFile;

    // In literal mode we're done — no classes to emit.
    if (mode === 'literal') return transformed;

    // Pass 3: insert class declarations at the top of the Elm runtime IIFE.
    // The compiled Elm output wraps its entire runtime in `(function(scope){...})(this)`.
    // We want the classes to live inside that IIFE so references are local to
    // its function scope — emitting them at script scope forces every `new $$V#`
    // call to traverse the scope chain on every invocation.
    const classDecls: ts.Statement[] = [];
    for (const ctor of ctors.values()) {
      classDecls.push(makeVariantClass(ctor));
    }

    const withClassesInIife = injectIntoIife(transformed, classDecls);
    if (withClassesInIife) return withClassesInIife;

    // Fallback: if we couldn't find the IIFE, prepend at script scope.
    return ts.factory.updateSourceFile(transformed, [
      ...classDecls,
      ...transformed.statements,
    ]);
  };
};

/**
 * Finds the top-level IIFE (matching either `(function(){...})(...)` or
 * `((function(){...})(...))` and its variations) and prepends statements to
 * its body. Returns null if no IIFE is found.
 *
 * The Elm compiler emits its runtime as a single IIFE; we look for the first
 * top-level ExpressionStatement whose underlying call expression invokes a
 * FunctionExpression.
 */
function injectIntoIife(
  source: ts.SourceFile,
  statements: ts.Statement[]
): ts.SourceFile | null {
  const unwrap = (expr: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
    return expr;
  };

  const newStatements = source.statements.map(stmt => {
    if (!ts.isExpressionStatement(stmt)) return stmt;
    const inner = unwrap(stmt.expression);
    if (!ts.isCallExpression(inner)) return stmt;
    const callee = unwrap(inner.expression);
    if (!ts.isFunctionExpression(callee)) return stmt;

    // Inject statements at the top of the function body.
    const newBody = ts.factory.createBlock(
      [...statements, ...callee.body.statements],
      true
    );
    const newFn = ts.factory.createFunctionExpression(
      callee.modifiers,
      callee.asteriskToken,
      callee.name,
      callee.typeParameters,
      callee.parameters,
      callee.type,
      newBody
    );
    const newCall = ts.factory.createCallExpression(
      newFn,
      inner.typeArguments,
      inner.arguments
    );
    // Preserve a single wrapping parenthesization since scripts typically
    // need `(function(){})()` rather than `function(){}()` to parse.
    const newExpr = ts.factory.createParenthesizedExpression(newCall);
    return ts.factory.createExpressionStatement(newExpr);
  });

  // Check whether we actually replaced the IIFE.
  const changed = newStatements.some((s, i) => s !== source.statements[i]);
  if (!changed) return null;

  return ts.factory.updateSourceFile(source, newStatements);
}

function makeVariantClass(ctor: VariantCtor): ts.ClassDeclaration {
  // constructor(param0, param1, ...) {
  //   this.$ = tag;
  //   this.field0 = paramForField0;
  //   this.field1 = paramForField1;
  //   ...
  // }
  const params = ctor.paramNames.map(p =>
    ts.factory.createParameterDeclaration(undefined, undefined, p)
  );

  const tagAssign = ts.factory.createExpressionStatement(
    ts.factory.createAssignment(
      ts.factory.createPropertyAccessExpression(ts.factory.createThis(), '$'),
      ts.factory.createNumericLiteral(ctor.tag)
    )
  );

  const fieldAssigns = ctor.fields.map((f, i) =>
    ts.factory.createExpressionStatement(
      ts.factory.createAssignment(
        ts.factory.createPropertyAccessExpression(ts.factory.createThis(), f),
        ts.factory.createIdentifier(ctor.fieldParams[i])
      )
    )
  );

  return ts.factory.createClassDeclaration(
    undefined,
    ctor.className,
    undefined,
    undefined,
    [
      ts.factory.createConstructorDeclaration(
        undefined,
        params,
        ts.factory.createBlock([tagAssign, ...fieldAssigns], true)
      ),
    ]
  );
}
