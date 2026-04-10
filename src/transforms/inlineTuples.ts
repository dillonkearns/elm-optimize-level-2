/*

Inline tuple constructor calls to avoid function call overhead.

Two modes:
  - 'literal': replaces _Utils_Tuple2(a, b) with { a: a, b: b }
  - 'class':   replaces _Utils_Tuple2(a, b) with new _Tuple2(a, b) and
               prepends class _Tuple2 { constructor(a, b) { this.a = a; this.b = b; } }

The 'class' mode is the V8-aware version. Object literal inlining at thousands
of call sites fragments V8's allocation-site feedback: each source location
gets its own hidden class, which turns downstream `.a`/`.b` property access
polymorphic or megamorphic. Class instances, by contrast, all share the hidden
class of their prototype regardless of call site, so ICs stay monomorphic.

Soundness: class instances are observationally indistinguishable from the
original plain-object tuples for every access pattern the Elm runtime uses
(_Utils_eq, _Utils_cmp, pattern-matching `.a`/`.b` access, JSON.stringify,
for..in iteration). _Utils_update is only used for records, never tuples.

*/

import ts from 'typescript';

const TUPLE2_FN = '_Utils_Tuple2';
const TUPLE3_FN = '_Utils_Tuple3';
const TUPLE2_CLASS = '_Tuple2';
const TUPLE3_CLASS = '_Tuple3';

export type InlineTuplesMode = 'literal' | 'class';

export const inlineTuples = (mode: InlineTuplesMode = 'class'): ts.TransformerFactory<ts.SourceFile> => context => {
  return sourceFile => {
    let usedTuple2 = false;
    let usedTuple3 = false;

    const visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isIdentifier(expression)) {
          if (expression.text === TUPLE2_FN && node.arguments.length === 2) {
            usedTuple2 = true;
            const args = [
              ts.visitNode(node.arguments[0], visitor) as ts.Expression,
              ts.visitNode(node.arguments[1], visitor) as ts.Expression,
            ];
            return mode === 'class'
              ? ts.factory.createNewExpression(
                  ts.factory.createIdentifier(TUPLE2_CLASS),
                  undefined,
                  args
                )
              : ts.factory.createObjectLiteralExpression([
                  ts.factory.createPropertyAssignment('a', args[0]),
                  ts.factory.createPropertyAssignment('b', args[1]),
                ]);
          }

          if (expression.text === TUPLE3_FN && node.arguments.length === 3) {
            usedTuple3 = true;
            const args = [
              ts.visitNode(node.arguments[0], visitor) as ts.Expression,
              ts.visitNode(node.arguments[1], visitor) as ts.Expression,
              ts.visitNode(node.arguments[2], visitor) as ts.Expression,
            ];
            return mode === 'class'
              ? ts.factory.createNewExpression(
                  ts.factory.createIdentifier(TUPLE3_CLASS),
                  undefined,
                  args
                )
              : ts.factory.createObjectLiteralExpression([
                  ts.factory.createPropertyAssignment('a', args[0]),
                  ts.factory.createPropertyAssignment('b', args[1]),
                  ts.factory.createPropertyAssignment('c', args[2]),
                ]);
          }
        }
      }
      return ts.visitEachChild(node, visitor, context);
    };

    const transformed = ts.visitNode(sourceFile, visitor) as ts.SourceFile;

    if (mode !== 'class' || (!usedTuple2 && !usedTuple3)) {
      return transformed;
    }

    // Prepend class declarations so they're in scope before any use.
    const classDecls: ts.Statement[] = [];
    if (usedTuple2) {
      classDecls.push(makeTupleClass(TUPLE2_CLASS, ['a', 'b']));
    }
    if (usedTuple3) {
      classDecls.push(makeTupleClass(TUPLE3_CLASS, ['a', 'b', 'c']));
    }

    return ts.factory.updateSourceFile(transformed, [
      ...classDecls,
      ...transformed.statements,
    ]);
  };
};

function makeTupleClass(name: string, fields: string[]): ts.ClassDeclaration {
  const params = fields.map(f =>
    ts.factory.createParameterDeclaration(undefined, undefined, f)
  );
  const assignments = fields.map(f =>
    ts.factory.createExpressionStatement(
      ts.factory.createAssignment(
        ts.factory.createPropertyAccessExpression(ts.factory.createThis(), f),
        ts.factory.createIdentifier(f)
      )
    )
  );
  const constructor = ts.factory.createConstructorDeclaration(
    undefined,
    params,
    ts.factory.createBlock(assignments, false)
  );
  return ts.factory.createClassDeclaration(
    undefined,
    name,
    undefined,
    undefined,
    [constructor]
  );
}
