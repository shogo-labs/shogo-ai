/**
 * Schema Transform Utilities
 * Task: task-2-3c-004
 *
 * Utilities for transforming schema data to ReactFlow graph format
 * and applying dagre layout for positioning.
 *
 * Per design-2-3c-003/004/005:
 * - transformSchemaToGraph converts SchemaModel[] to nodes/edges
 * - applyDagreLayout positions nodes using dagre with TB layout
 * - Edge styling derived from x-mst-type field
 */

import dagre from "dagre"
import { MarkerType, type Node, type Edge } from "@xyflow/react"
import type { SchemaModel, SchemaField } from "../hooks/useSchemaData"

/**
 * Entity node data type for ReactFlow
 */
export interface EntityNodeData {
  name: string
  propertyCount: number
  referenceCount: number
  properties: SchemaField[]
  isSelected: boolean
}

/**
 * Reference edge data type for ReactFlow
 */
export interface ReferenceEdgeData {
  label: string
  isOptional: boolean
}

/**
 * Graph result from transformation
 */
export interface TransformResult {
  nodes: Node<EntityNodeData>[]
  edges: Edge<ReferenceEdgeData>[]
}

// Known model names in the current schema (for edge target resolution)
let modelNames: Set<string> = new Set()

/**
 * Check if a field is a reference type
 */
function isReferenceField(field: SchemaField): boolean {
  return (
    field.type === "reference" ||
    field.type === "reference[]" ||
    field["x-mst-type"] === "reference" ||
    field["x-mst-type"] === "maybe-reference"
  )
}

/**
 * Determine if a reference is optional (maybe-reference)
 */
function isOptionalReference(field: SchemaField): boolean {
  return field["x-mst-type"] === "maybe-reference"
}

/**
 * Infer target model name from field name or type
 * Uses x-reference-target if available, otherwise falls back to heuristics
 */
function inferTargetModel(field: SchemaField, models: SchemaModel[]): string | null {
  // First, check explicit x-reference-target (highest priority)
  const explicitTarget = (field as any)['x-reference-target']
  if (explicitTarget && modelNames.has(explicitTarget)) {
    return explicitTarget
  }

  // Check if field name matches a model (common pattern)
  const fieldNameCapitalized = field.name.charAt(0).toUpperCase() + field.name.slice(1)
  if (modelNames.has(fieldNameCapitalized)) {
    return fieldNameCapitalized
  }

  // Check if field name is plural and singular matches a model
  if (field.name.endsWith("s")) {
    const singular = field.name.slice(0, -1)
    const singularCapitalized = singular.charAt(0).toUpperCase() + singular.slice(1)
    if (modelNames.has(singularCapitalized)) {
      return singularCapitalized
    }
  }

  // Check if type contains a model name reference
  for (const model of models) {
    if (
      field.type.includes(model.name) ||
      field.name.toLowerCase().includes(model.name.toLowerCase())
    ) {
      return model.name
    }
  }

  return null
}

/**
 * Transform schema models to ReactFlow nodes and edges
 *
 * @param models - Array of SchemaModel from useSchemaData
 * @returns { nodes, edges } for ReactFlow
 */
export function transformSchemaToGraph(models: SchemaModel[]): TransformResult {
  if (!models || models.length === 0) {
    return { nodes: [], edges: [] }
  }

  // Build set of model names for reference resolution
  modelNames = new Set(models.map((m) => m.name))

  const nodes: Node<EntityNodeData>[] = []
  const edges: Edge<ReferenceEdgeData>[] = []

  // Create nodes from models
  for (const model of models) {
    const referenceFields = model.fields.filter(isReferenceField)
    const nonReferenceFields = model.fields.filter((f) => !isReferenceField(f))

    nodes.push({
      id: model.name,
      type: "entity",
      position: { x: 0, y: 0 }, // Will be positioned by dagre
      data: {
        name: model.name,
        propertyCount: nonReferenceFields.length,
        referenceCount: referenceFields.length,
        properties: model.fields,
        isSelected: false,
      },
    })

    // Create edges from reference fields
    for (const field of referenceFields) {
      const targetModel = inferTargetModel(field, models)
      if (targetModel && modelNames.has(targetModel)) {
        const isOptional = isOptionalReference(field)
        edges.push({
          id: `${model.name}-${field.name}-${targetModel}`,
          source: model.name,
          target: targetModel,
          type: "reference",
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: isOptional ? "hsl(var(--muted-foreground))" : "hsl(var(--primary))",
          },
          style: {
            stroke: isOptional ? "hsl(var(--muted-foreground))" : "hsl(var(--primary))",
            strokeWidth: 2,
            strokeDasharray: isOptional ? "4" : undefined,
          },
          data: {
            label: field.name,
            isOptional,
          },
        })
      }
    }
  }

  return { nodes, edges }
}

/**
 * Apply dagre layout to position nodes
 *
 * @param nodes - ReactFlow nodes from transformSchemaToGraph
 * @param edges - ReactFlow edges from transformSchemaToGraph
 * @returns Positioned nodes and unchanged edges
 */
export function applyDagreLayout(
  nodes: Node<EntityNodeData>[],
  edges: Edge<ReferenceEdgeData>[]
): TransformResult {
  if (nodes.length === 0) {
    return { nodes, edges }
  }

  // Create dagre graph
  const g = new dagre.graphlib.Graph()

  // Configure graph for top-to-bottom layout per vault spec
  g.setGraph({
    rankdir: "TB",
    nodesep: 50,
    ranksep: 100,
  })

  // Set default edge label (required by dagre)
  g.setDefaultEdgeLabel(() => ({}))

  // Add nodes with dimensions per vault spec (200x80)
  for (const node of nodes) {
    g.setNode(node.id, {
      width: 200,
      height: 80,
    })
  }

  // Add edges
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  // Run dagre layout
  dagre.layout(g)

  // Apply positions to nodes
  const positionedNodes = nodes.map((node) => {
    const nodeWithPosition = g.node(node.id)
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 100, // Center node (half of 200 width)
        y: nodeWithPosition.y - 40, // Center node (half of 80 height)
      },
    }
  })

  return { nodes: positionedNodes, edges }
}
