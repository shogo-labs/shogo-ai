/**
 * SchemaVisualizer - React Flow visualization of Wavesmith schemas
 *
 * Converts Enhanced JSON Schema models into a visual graph showing
 * entities and their relationships.
 */

import { useCallback, useMemo } from "react"
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  ConnectionLineType,
  MarkerType,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"

import { DatabaseSchemaNode, type SchemaField, type DatabaseSchemaNodeData } from "./DatabaseSchemaNode"

// Types for schema model data from Wavesmith
export interface ModelField {
  name: string
  type: string
  required: boolean
}

export interface SchemaModel {
  name: string
  collectionName: string
  fields: ModelField[]
}

interface SchemaVisualizerProps {
  models: SchemaModel[]
  schemaName: string
}

// Node types for React Flow
const nodeTypes: NodeTypes = {
  databaseSchema: DatabaseSchemaNode as any,
}

// Map Wavesmith field types to display types
const mapFieldType = (field: ModelField): SchemaField => {
  const isIdentifier = field.name === "id"
  const isReference = field.type === "reference" || field.type === "reference[]"
  const isArray = field.type.endsWith("[]") || field.type === "array"

  // Extract base type
  let displayType = field.type
  if (field.type === "reference") {
    displayType = "ref"
  } else if (field.type === "reference[]") {
    displayType = "ref[]"
  }

  return {
    name: field.name,
    type: displayType,
    isIdentifier,
    isReference,
    isRequired: field.required,
    isArray,
  }
}

// Auto-layout nodes in a grid pattern
const layoutNodes = (models: SchemaModel[]): Node<DatabaseSchemaNodeData>[] => {
  const nodesPerRow = 3
  const nodeWidth = 280
  const nodeHeight = 250
  const horizontalGap = 100
  const verticalGap = 80

  return models.map((model, index) => {
    const row = Math.floor(index / nodesPerRow)
    const col = index % nodesPerRow

    return {
      id: model.name,
      type: "databaseSchema",
      position: {
        x: col * (nodeWidth + horizontalGap),
        y: row * (nodeHeight + verticalGap),
      },
      data: {
        label: model.name,
        schema: model.fields.map(mapFieldType),
      },
    }
  })
}

// Create edges from reference fields
const createEdges = (models: SchemaModel[]): Edge[] => {
  const edges: Edge[] = []
  const modelNames = new Set(models.map(m => m.name))

  models.forEach(model => {
    model.fields.forEach(field => {
      if (field.type === "reference" || field.type === "reference[]") {
        // Try to infer target model from field name
        // Common patterns: "session" -> "FeatureSession", "requirement" -> "Requirement"
        let targetModel: string | null = null

        // Check if field name matches a model name (case-insensitive)
        for (const name of modelNames) {
          if (name.toLowerCase() === field.name.toLowerCase()) {
            targetModel = name
            break
          }
          // Check if field name is a suffix (e.g., "session" matches "FeatureSession")
          if (name.toLowerCase().endsWith(field.name.toLowerCase())) {
            targetModel = name
            break
          }
        }

        // Special cases for common patterns
        if (!targetModel) {
          if (field.name === "session" && modelNames.has("FeatureSession")) {
            targetModel = "FeatureSession"
          } else if (field.name === "task" && modelNames.has("ImplementationTask")) {
            targetModel = "ImplementationTask"
          } else if (field.name === "run" && modelNames.has("ImplementationRun")) {
            targetModel = "ImplementationRun"
          } else if (field.name === "finding" && modelNames.has("AnalysisFinding")) {
            targetModel = "AnalysisFinding"
          } else if (field.name === "integrationPoint" && modelNames.has("IntegrationPoint")) {
            targetModel = "IntegrationPoint"
          } else if (field.name === "dependencies" && modelNames.has("ImplementationTask")) {
            targetModel = "ImplementationTask"
          }
        }

        if (targetModel && targetModel !== model.name) {
          edges.push({
            id: `${model.name}-${field.name}-${targetModel}`,
            source: model.name,
            sourceHandle: `${field.name}-source`,
            target: targetModel,
            targetHandle: "id-target",
            type: "smoothstep",
            animated: true,
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: "#9c27b0",
            },
            style: {
              stroke: "#9c27b0",
              strokeWidth: 2,
            },
          })
        }
      }
    })
  })

  return edges
}

// Styles
const containerStyle: React.CSSProperties = {
  width: "100%",
  height: "600px",
  background: "#0a0a0a",
  borderRadius: "8px",
  border: "1px solid #333",
}

const headerStyle: React.CSSProperties = {
  padding: "12px 16px",
  background: "#1e1e1e",
  borderBottom: "1px solid #333",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
}

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "14px",
  fontWeight: "bold",
  color: "#fff",
}

const subtitleStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "#888",
}

const flowContainerStyle: React.CSSProperties = {
  width: "100%",
  height: "calc(100% - 50px)",
}

const legendStyle: React.CSSProperties = {
  display: "flex",
  gap: "16px",
  fontSize: "11px",
  color: "#888",
}

const legendItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
}

const pkBadge: React.CSSProperties = {
  background: "#ff9800",
  color: "#000",
  padding: "1px 4px",
  borderRadius: "3px",
  fontSize: "9px",
  fontWeight: "bold",
}

const fkBadge: React.CSSProperties = {
  background: "#9c27b0",
  color: "#fff",
  padding: "1px 4px",
  borderRadius: "3px",
  fontSize: "9px",
  fontWeight: "bold",
}

export function SchemaVisualizer({ models, schemaName }: SchemaVisualizerProps) {
  // Create nodes and edges from models
  const initialNodes = useMemo(() => layoutNodes(models), [models])
  const initialEdges = useMemo(() => createEdges(models), [models])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div>
          <h3 style={titleStyle}>Schema: {schemaName}</h3>
          <span style={subtitleStyle}>{models.length} models, {initialEdges.length} relationships</span>
        </div>
        <div style={legendStyle}>
          <span style={legendItemStyle}>
            <span style={pkBadge}>PK</span> Primary Key
          </span>
          <span style={legendItemStyle}>
            <span style={fkBadge}>FK</span> Foreign Key
          </span>
          <span style={legendItemStyle}>
            <span style={{ color: "#f44336" }}>*</span> Required
          </span>
        </div>
      </div>
      <div style={flowContainerStyle}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          connectionLineType={ConnectionLineType.SmoothStep}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.3}
          maxZoom={1.5}
          defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
        >
          <Background color="#333" gap={20} />
          <Controls
            style={{ background: "#1e1e1e", borderRadius: "4px" }}
          />
          <MiniMap
            style={{ background: "#1e1e1e", borderRadius: "4px" }}
            nodeColor={() => "#2196f3"}
            maskColor="rgba(0, 0, 0, 0.8)"
          />
        </ReactFlow>
      </div>
    </div>
  )
}
