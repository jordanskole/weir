// spikes/ts-prototype/src/metadata.ts
/**
 * Analytics about an accepted implementation's source — a side-channel,
 * never read by the elaborator, hash.ts, or any acceptance logic, and
 * never fed back to change behavior or as something an agent should
 * optimize against (docs/superpowers/specs/2026-09-10-sealed-contract-and-implementation-metadata.md).
 */

import * as ts from "typescript";

export interface ImplementationMetadata {
  lines: number;
  complexity: number;
}

/**
 * McCabe cyclomatic complexity's standard decision-point set. CaseClause
 * (not DefaultClause) means a switch's default branch is correctly
 * excluded without extra logic — the compiler API already distinguishes
 * them as different node kinds.
 */
const DECISION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

function countDecisionPoints(node: ts.Node): number {
  let count = DECISION_KINDS.has(node.kind) ? 1 : 0;
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) count += 1;
  }
  node.forEachChild((child) => {
    count += countDecisionPoints(child);
  });
  return count;
}

export function computeImplementationMetadata(source: string): ImplementationMetadata {
  const lines = source.trim().split("\n").length;
  const sourceFile = ts.createSourceFile("implementation.ts", source, ts.ScriptTarget.Latest, true);
  const complexity = 1 + countDecisionPoints(sourceFile);
  return { lines, complexity };
}
