/**
 * EntityDetailsPanel Component
 * Task: task-2-3c-008
 *
 * Side panel displaying detailed information about a selected entity.
 *
 * Per design-2-3c-012:
 * - Shows entity name, properties with types, x-extensions
 * - Includes collapsible JSON Schema view
 * - Has close button to deselect entity
 */

import { useState } from "react"
import { X, ChevronDown, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { SchemaModel, SchemaField } from "./hooks/useSchemaData"

/**
 * Props for EntityDetailsPanel component
 */
export interface EntityDetailsPanelProps {
  entity: SchemaModel | null
  onClose: () => void
}

/**
 * EntityDetailsPanel Component
 *
 * Renders detailed information about the selected entity including
 * properties, types, and x-extension metadata.
 */
export function EntityDetailsPanel({
  entity,
  onClose,
}: EntityDetailsPanelProps) {
  const [schemaExpanded, setSchemaExpanded] = useState(false)

  // Return null when no entity selected
  if (!entity) {
    return null
  }

  return (
    <div
      data-testid="entity-details-panel"
      className="w-80 border-l bg-card h-full flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-semibold text-foreground">{entity.name}</h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          data-testid="close-details-button"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Collection Name */}
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
            Collection
          </h4>
          <p className="text-sm text-foreground">{entity.collectionName}</p>
        </div>

        {/* Properties */}
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Properties ({entity.fields.length})
          </h4>
          <div className="space-y-2">
            {entity.fields.map((field) => (
              <PropertyItem key={field.name} field={field} />
            ))}
          </div>
        </div>

        {/* Collapsible JSON Schema */}
        <div>
          <button
            onClick={() => setSchemaExpanded(!schemaExpanded)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 hover:text-foreground transition-colors"
          >
            {schemaExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            JSON Schema
          </button>
          {schemaExpanded && (
            <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto">
              {JSON.stringify(
                {
                  name: entity.name,
                  collectionName: entity.collectionName,
                  fields: entity.fields,
                },
                null,
                2
              )}
            </pre>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * PropertyItem - Renders a single property with its metadata
 */
function PropertyItem({ field }: { field: SchemaField }) {
  const isReference = field.mstType === "reference" || field.mstType === "maybe-reference"
  const isComputed = field.computed

  return (
    <div
      className={cn(
        "text-sm p-2 rounded bg-muted/30",
        isComputed && "opacity-75"
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-foreground">{field.name}</span>
        <span className="text-xs text-muted-foreground">{field.type}</span>
      </div>

      {/* Reference Target */}
      {isReference && field.referenceTarget && (
        <div className="text-xs text-muted-foreground mt-1">
          <span className="text-primary">→</span> {field.referenceTarget}
          {field.mstType === "maybe-reference" && " (optional)"}
        </div>
      )}

      {/* X-Extension Metadata */}
      <div className="flex flex-wrap gap-1 mt-1">
        {field.arktype && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
            arktype: {field.arktype}
          </span>
        )}
        {field.mstType && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-secondary/50 text-secondary-foreground">
            mstType: {field.mstType}
          </span>
        )}
        {field.computed && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-700 dark:text-amber-400">
            computed
          </span>
        )}
      </div>
    </div>
  )
}
