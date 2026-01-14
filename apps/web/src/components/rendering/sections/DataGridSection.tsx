/**
 * DataGridSection Component
 * Task: view-builder-implementation
 * Spec: spec-data-grid-section
 *
 * Renders any Wavesmith collection as a configurable data grid/table.
 * Generic, reusable component that works with any schema/model combination.
 *
 * Data bindings:
 * - (configurable).{model}: Primary data source - collection to render as grid rows
 * - component-builder meta introspection: PropertyMetadata for column types
 *
 * Config options:
 * - schema: string - Schema name to query (e.g., "platform-features")
 * - model: string - Model/collection name (e.g., "Requirement")
 * - columns: string[] - Property names to display as columns
 * - title: string - Optional section title
 * - onRowSelect: (entity: any) => void - Callback when row is clicked
 * - stickyFirstColumn: boolean - Keep first column visible on scroll
 */

import { useState, useMemo } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { PropertyRenderer } from "../PropertyRenderer"
import { cn } from "@/lib/utils"
import type { SectionRendererProps } from "../sectionImplementations"
import type { PropertyMetadata } from "../types"

// ============================================================================
// Types
// ============================================================================

interface DataGridConfig {
  /** Schema name to query */
  schema?: string
  /** Model/collection name */
  model?: string
  /** Property names to display as columns */
  columns?: string[]
  /** Optional section title */
  title?: string
  /** Whether first column should be sticky on horizontal scroll */
  stickyFirstColumn?: boolean
  /** Callback when row is clicked */
  onRowSelect?: (entity: any) => void
}

type SortDirection = "asc" | "desc" | null

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get collection name from model name (e.g., "Requirement" -> "requirementCollection")
 */
function getCollectionName(model: string): string {
  return `${model.charAt(0).toLowerCase()}${model.slice(1)}Collection`
}

/**
 * Infer PropertyMetadata from a value for type-aware rendering
 */
function inferPropertyMetadata(key: string, value: any): PropertyMetadata {
  // Basic type inference
  let jsonType: PropertyMetadata["jsonType"] = "string"
  let format: string | undefined

  if (typeof value === "number") {
    jsonType = "number"
    // Check if it looks like a timestamp
    if (key.toLowerCase().includes("at") && value > 1000000000000) {
      format = "date-time"
    }
  } else if (typeof value === "boolean") {
    jsonType = "boolean"
  } else if (Array.isArray(value)) {
    jsonType = "array"
  } else if (value !== null && typeof value === "object") {
    jsonType = "object"
  } else if (typeof value === "string") {
    // Check for common patterns
    if (key.toLowerCase().includes("email")) {
      format = "email"
    } else if (key.toLowerCase().includes("url") || key.toLowerCase().includes("uri")) {
      format = "uri"
    } else if (key === "id") {
      format = "identifier"
    }
  }

  return {
    name: key,
    jsonType,
    format,
    required: false,
    isComputed: false,
  }
}

/**
 * Sort data by column
 */
function sortData(data: any[], column: string | null, direction: SortDirection): any[] {
  if (!column || !direction) return data

  return [...data].sort((a, b) => {
    const aVal = a[column]
    const bVal = b[column]

    // Handle null/undefined
    if (aVal == null && bVal == null) return 0
    if (aVal == null) return direction === "asc" ? -1 : 1
    if (bVal == null) return direction === "asc" ? 1 : -1

    // Compare based on type
    if (typeof aVal === "number" && typeof bVal === "number") {
      return direction === "asc" ? aVal - bVal : bVal - aVal
    }

    // String comparison
    const aStr = String(aVal).toLowerCase()
    const bStr = String(bVal).toLowerCase()
    if (direction === "asc") {
      return aStr.localeCompare(bStr)
    }
    return bStr.localeCompare(aStr)
  })
}

// ============================================================================
// Component
// ============================================================================

/**
 * DataGridSection Component
 *
 * Renders any Wavesmith collection as a data grid with configurable columns.
 * Uses PropertyRenderer for type-aware cell rendering.
 *
 * @param props - SectionRendererProps with feature and config
 */
export const DataGridSection = observer(function DataGridSection({
  feature,
  config,
}: SectionRendererProps) {
  const domains = useDomains()
  const gridConfig = config as DataGridConfig | undefined

  // State for sorting
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>(null)

  // State for row selection
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)

  // Extract config with defaults
  const schema = gridConfig?.schema
  const model = gridConfig?.model
  const columns = gridConfig?.columns ?? []
  const title = gridConfig?.title ?? (model ? `${model} Data` : "Data Grid")
  const stickyFirstColumn = gridConfig?.stickyFirstColumn ?? false
  const onRowSelect = gridConfig?.onRowSelect

  // Handle missing configuration
  if (!schema || !model) {
    return (
      <section data-testid="data-grid-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            Configuration required: specify schema and model
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Example: {`{ schema: "platform-features", model: "Requirement" }`}
          </p>
        </div>
      </section>
    )
  }

  // Get the domain store based on schema name
  // Map common schema names to domain keys
  const domainKeyMap: Record<string, string> = {
    "platform-features": "platformFeatures",
    "component-builder": "componentBuilder",
    "studio-core": "studioCore",
    "studio-chat": "studioChat",
  }

  const domainKey = domainKeyMap[schema] ?? schema
  const domainStore = (domains as any)?.[domainKey]

  if (!domainStore) {
    return (
      <section data-testid="data-grid-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            Domain not found: {schema}
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Available: platform-features, component-builder, studio-core, studio-chat
          </p>
        </div>
      </section>
    )
  }

  // Get the collection
  const collectionName = getCollectionName(model)
  const collection = domainStore[collectionName]

  if (!collection) {
    return (
      <section data-testid="data-grid-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            Collection not found: {collectionName}
          </p>
        </div>
      </section>
    )
  }

  // Fetch data - use all() to get everything, or filter by session if available
  let rawData: any[] = []
  if (feature && collection.findBySession) {
    rawData = collection.findBySession(feature.id) ?? []
  } else if (collection.all) {
    rawData = collection.all() ?? []
  } else if (collection.query) {
    rawData = collection.query().toArray() ?? []
  }

  // Auto-detect columns if not specified
  const effectiveColumns = useMemo(() => {
    if (columns.length > 0) return columns
    if (rawData.length === 0) return []

    // Get keys from first item, excluding internal MST properties
    const firstItem = rawData[0]
    return Object.keys(firstItem).filter(
      key => !key.startsWith("$") && key !== "toJSON"
    )
  }, [columns, rawData])

  // Sort the data
  const sortedData = useMemo(() => {
    return sortData(rawData, sortColumn, sortDirection)
  }, [rawData, sortColumn, sortDirection])

  // Handle column header click for sorting
  const handleHeaderClick = (column: string) => {
    if (sortColumn === column) {
      // Cycle through: asc -> desc -> null
      if (sortDirection === "asc") {
        setSortDirection("desc")
      } else if (sortDirection === "desc") {
        setSortColumn(null)
        setSortDirection(null)
      }
    } else {
      setSortColumn(column)
      setSortDirection("asc")
    }
  }

  // Handle row click
  const handleRowClick = (entity: any) => {
    setSelectedRowId(entity.id)
    onRowSelect?.(entity)
  }

  // Handle empty data
  if (sortedData.length === 0) {
    return (
      <section data-testid="data-grid-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">
            No data available
          </p>
        </div>
      </section>
    )
  }

  // Render the data grid
  return (
    <section data-testid="data-grid-section" className="h-full flex flex-col">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        {title} ({sortedData.length})
      </h3>

      <div className="flex-1 overflow-auto border rounded-lg">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 bg-muted/80 backdrop-blur-sm">
            <tr>
              {effectiveColumns.map((column, index) => (
                <th
                  key={column}
                  onClick={() => handleHeaderClick(column)}
                  className={cn(
                    "px-3 py-2 text-left font-medium text-muted-foreground cursor-pointer hover:bg-muted transition-colors border-b",
                    stickyFirstColumn && index === 0 && "sticky left-0 bg-muted/80 backdrop-blur-sm z-10",
                    sortColumn === column && "text-foreground"
                  )}
                >
                  <div className="flex items-center gap-1">
                    <span className="capitalize">{column.replace(/([A-Z])/g, " $1").trim()}</span>
                    {sortColumn === column && (
                      <span className="text-xs">
                        {sortDirection === "asc" ? "↑" : "↓"}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedData.map((entity: any) => (
              <tr
                key={entity.id}
                onClick={() => handleRowClick(entity)}
                className={cn(
                  "border-b border-border/50 cursor-pointer transition-colors",
                  selectedRowId === entity.id
                    ? "bg-primary/10"
                    : "hover:bg-muted/50"
                )}
              >
                {effectiveColumns.map((column, index) => {
                  const value = entity[column]
                  const propertyMeta = inferPropertyMetadata(column, value)

                  return (
                    <td
                      key={column}
                      className={cn(
                        "px-3 py-2",
                        stickyFirstColumn && index === 0 && "sticky left-0 bg-background z-10"
                      )}
                    >
                      <PropertyRenderer
                        property={propertyMeta}
                        value={value}
                        entity={entity}
                        config={{ size: "sm" }}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
})
