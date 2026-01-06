/**
 * SchemaGraph Component
 * Task: task-2-3c-007
 *
 * ReactFlow-based schema visualization showing entities and their relationships.
 *
 * Per design-2-3c-012:
 * - Uses ReactFlow with custom EntityNode and ReferenceEdge
 * - Transforms SchemaModel[] to graph nodes/edges
 * - Applies dagre auto-layout
 * - Handles node selection with callback
 */

import { useState, useEffect, useMemo, useCallback } from "react"
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  type OnNodeClick,
  type OnPaneClick,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { EntityNode } from "./EntityNode"
import { ReferenceEdge } from "./ReferenceEdge"
import {
  transformSchemaToGraph,
  applyDagreLayout,
  type EntityNodeData,
  type ReferenceEdgeData,
} from "./utils/schemaTransform"
import type { SchemaModel } from "./hooks/useSchemaData"

/**
 * Props for SchemaGraph component
 */
export interface SchemaGraphProps {
  models: SchemaModel[]
  selectedEntityId?: string | null
  onSelectEntity?: (entityId: string | null) => void
}

/**
 * Custom node types for ReactFlow
 */
const nodeTypes: NodeTypes = {
  entity: EntityNode,
}

/**
 * Custom edge types for ReactFlow
 */
const edgeTypes: EdgeTypes = {
  reference: ReferenceEdge,
}

/**
 * SchemaGraph Component
 *
 * Renders a visual graph of schema entities and their relationships.
 * Uses dagre for automatic layout.
 */
export function SchemaGraph({
  models,
  selectedEntityId,
  onSelectEntity,
}: SchemaGraphProps) {
  const [nodes, setNodes] = useState<Node<EntityNodeData>[]>([])
  const [edges, setEdges] = useState<Edge<ReferenceEdgeData>[]>([])

  // Transform models to graph on mount or when models change
  useEffect(() => {
    if (!models || models.length === 0) {
      setNodes([])
      setEdges([])
      return
    }

    // Transform schema models to graph structure
    const { nodes: rawNodes, edges: rawEdges } = transformSchemaToGraph(models)

    // Apply dagre layout for positioning
    const { nodes: layoutNodes, edges: layoutEdges } = applyDagreLayout(
      rawNodes,
      rawEdges
    )

    setNodes(layoutNodes)
    setEdges(layoutEdges)
  }, [models])

  // Update node selection state when selectedEntityId changes
  const nodesWithSelection = useMemo(() => {
    return nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        isSelected: node.id === selectedEntityId,
      },
    }))
  }, [nodes, selectedEntityId])

  // Handle node click to select entity
  const handleNodeClick: OnNodeClick<Node<EntityNodeData>> = useCallback(
    (_event, node) => {
      onSelectEntity?.(node.id)
    },
    [onSelectEntity]
  )

  // Handle pane click to deselect
  const handlePaneClick: OnPaneClick = useCallback(() => {
    onSelectEntity?.(null)
  }, [onSelectEntity])

  return (
    <div data-testid="schema-graph" className="h-full w-full">
      <ReactFlow
        nodes={nodesWithSelection}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
        defaultEdgeOptions={{
          type: "reference",
        }}
      >
        <Controls />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
      </ReactFlow>
    </div>
  )
}
