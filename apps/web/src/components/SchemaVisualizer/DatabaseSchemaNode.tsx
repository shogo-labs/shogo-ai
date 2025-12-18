/**
 * DatabaseSchemaNode - React Flow node component for visualizing database/domain schemas
 *
 * Based on https://reactflow.dev/ui/components/database-schema-node
 */

import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"

// Types
export interface SchemaField {
  name: string
  type: string
  isIdentifier?: boolean
  isReference?: boolean
  referenceTarget?: string
  isRequired?: boolean
  isArray?: boolean
}

export interface DatabaseSchemaNodeData {
  label: string
  schema: SchemaField[]
}

// Styles
const nodeContainerStyle: React.CSSProperties = {
  background: "#1e1e1e",
  borderRadius: "8px",
  border: "1px solid #333",
  minWidth: "220px",
  fontSize: "12px",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
}

const headerStyle: React.CSSProperties = {
  background: "#2196f3",
  color: "white",
  padding: "8px 12px",
  fontWeight: "bold",
  borderTopLeftRadius: "7px",
  borderTopRightRadius: "7px",
  fontSize: "13px",
}

const bodyStyle: React.CSSProperties = {
  padding: "0",
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 12px",
  borderBottom: "1px solid #333",
  position: "relative",
}

const lastRowStyle: React.CSSProperties = {
  ...rowStyle,
  borderBottom: "none",
}

const fieldNameStyle: React.CSSProperties = {
  color: "#e0e0e0",
  display: "flex",
  alignItems: "center",
  gap: "6px",
}

const fieldTypeStyle: React.CSSProperties = {
  color: "#888",
  fontSize: "11px",
  fontFamily: "monospace",
}

const identifierBadgeStyle: React.CSSProperties = {
  background: "#ff9800",
  color: "#000",
  padding: "1px 4px",
  borderRadius: "3px",
  fontSize: "9px",
  fontWeight: "bold",
}

const referenceBadgeStyle: React.CSSProperties = {
  background: "#9c27b0",
  color: "#fff",
  padding: "1px 4px",
  borderRadius: "3px",
  fontSize: "9px",
  fontWeight: "bold",
}

const requiredStyle: React.CSSProperties = {
  color: "#f44336",
  marginLeft: "2px",
}

const handleStyle: React.CSSProperties = {
  width: "10px",
  height: "10px",
  background: "#2196f3",
  border: "2px solid #1e1e1e",
}

const sourceHandleStyle: React.CSSProperties = {
  ...handleStyle,
  background: "#9c27b0",
}

// Helper to format type display
const formatType = (field: SchemaField): string => {
  let type = field.type
  if (field.isArray) {
    type = `${type}[]`
  }
  return type
}

// Component
export const DatabaseSchemaNode = memo(({ data }: NodeProps<DatabaseSchemaNodeData>) => {
  return (
    <div style={nodeContainerStyle}>
      <div style={headerStyle}>
        {data.label}
      </div>
      <div style={bodyStyle}>
        {data.schema.map((field, index) => (
          <div
            key={field.name}
            style={index === data.schema.length - 1 ? lastRowStyle : rowStyle}
          >
            {/* Target handle for references pointing TO this field */}
            {field.isIdentifier && (
              <Handle
                type="target"
                position={Position.Left}
                id={`${field.name}-target`}
                style={{ ...handleStyle, top: "50%" }}
              />
            )}

            <span style={fieldNameStyle}>
              {field.isIdentifier && <span style={identifierBadgeStyle}>PK</span>}
              {field.isReference && <span style={referenceBadgeStyle}>FK</span>}
              <span>{field.name}</span>
              {field.isRequired && <span style={requiredStyle}>*</span>}
            </span>

            <span style={fieldTypeStyle}>
              {formatType(field)}
            </span>

            {/* Source handle for references FROM this field */}
            {field.isReference && (
              <Handle
                type="source"
                position={Position.Right}
                id={`${field.name}-source`}
                style={{ ...sourceHandleStyle, top: "50%" }}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
})

DatabaseSchemaNode.displayName = "DatabaseSchemaNode"
