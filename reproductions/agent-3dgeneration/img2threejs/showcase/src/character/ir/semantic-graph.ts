import type { CharacterIR, SemanticEdge, SemanticGraph, SemanticNode, SemanticRelation } from "./character-ir.js";

export function addSemanticNode(graph: SemanticGraph, node: SemanticNode): void {
  if (graph.nodes.some((candidate) => candidate.id === node.id)) {
    throw new Error(`semantic node already exists: ${node.id}`);
  }
  graph.nodes.push(node);
}

export function addSemanticRelation(
  graph: SemanticGraph,
  from: string,
  to: string,
  relation: SemanticRelation,
  confidence = 1,
): void {
  if (!graph.nodes.some((node) => node.id === from) || !graph.nodes.some((node) => node.id === to)) {
    throw new Error(`semantic relation references unknown node: ${from} -> ${to}`);
  }
  graph.edges.push({ from, to, relation, confidence });
}

export function relationsFor(graph: SemanticGraph, nodeId: string, relation?: SemanticRelation): SemanticEdge[] {
  return graph.edges.filter((edge) => (edge.from === nodeId || edge.to === nodeId) && (!relation || edge.relation === relation));
}

export function validateSemanticGraph(graph: SemanticGraph): string[] {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const errors: string[] = [];
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) errors.push(`unknown edge source: ${edge.from}`);
    if (!ids.has(edge.to)) errors.push(`unknown edge target: ${edge.to}`);
    if (edge.from === edge.to && edge.relation !== "surface-bound") errors.push(`self relation is not allowed: ${edge.from}`);
  }
  return errors;
}

export function assertCharacterGraph(ir: CharacterIR): void {
  const errors = validateSemanticGraph(ir.semanticGraph);
  if (errors.length > 0) throw new Error(`invalid CharacterIR semantic graph: ${errors.join("; ")}`);
}
