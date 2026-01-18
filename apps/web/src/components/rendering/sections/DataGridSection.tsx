/**
 * DataGridSection Component
 *
 * Renders any Wavesmith collection as a configurable data grid/table.
 * Generic, reusable component that works with any schema/model combination.
 *
 * Uses platform abstractions:
 * - Meta-store for column metadata (PropertyMetadata from model.properties)
 * - DomainProvider for schema-name-based store lookup
 * - Unified sync/async data loading hook
 *
 * Config options:
 * - schema: string - Schema name (e.g., "platform-features")
 * - model: string - Model name (e.g., "Requirement")
 * - columns: string[] - Property names to display (auto-detect if omitted)
 * - excludeColumns: string[] - Properties to exclude from auto-detect
 * - sessionFilter: boolean - Filter by feature.id (default true when feature present)
 * - staticFilter: object - Static filter using collection.where()
 * - query: object - Async query with filter, orderBy, skip, take
 * - title: string - Optional section title
 * - stickyFirstColumn: boolean - Keep first column visible on scroll
 * - onRowSelect: (entity: any) => void - Callback when row is clicked
 */

import { useState, useMemo, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { PropertyRenderer } from "../PropertyRenderer"
import { cn } from "@/lib/utils"
import type { SectionRendererProps } from "../sectionImplementations"
import { useDataGridMetadata, useDataGridData } from "./hooks"

// ============================================================================
// Types
// ============================================================================

interface DataGridConfig {
  /** Schema name (e.g., "platform-features") */
  schema?: string
  /** Schema name - alternate key for compatibility */
  schemaName?: string
  /** Workspace/projectId for project-specific schema loading */
  schemaWorkspace?: string
  /** Model name (e.g., "Requirement") */
  model?: string

  // Column configuration
  /** Property names to display as columns */
  columns?: string[]
  /** Properties to exclude from auto-detect */
  excludeColumns?: string[]

  // Sync data filtering (MST views - reactive)
  /** Use findBySession(feature.id) - default true when feature present */
  sessionFilter?: boolean
  /** Static filter using collection.where() */
  staticFilter?: Record<string, any>

  // Async query configuration (query builder)
  /** Async query - if present, uses query builder instead of MST views */
  query?: {
    filter?: Record<string, any>
    orderBy?: { field: string; direction: "asc" | "desc" }[]
    skip?: number
    take?: number
  }

  // Display options
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

/**
 * Fallback: Infer PropertyMetadata from a value when meta-store doesn't have it
 */
function inferPropertyMetadata(key: string, value: any): any {
  let type: string = "string"
  let format: string | undefined

  if (typeof value === "number") {
    type = "number"
    if (key.toLowerCase().includes("at") && value > 1000000000000) {
      format = "date-time"
    }
  } else if (typeof value === "boolean") {
    type = "boolean"
  } else if (Array.isArray(value)) {
    type = "array"
  } else if (value !== null && typeof value === "object") {
    type = "object"
  } else if (typeof value === "string") {
    if (key.toLowerCase().includes("email")) {
      format = "email"
    } else if (key.toLowerCase().includes("url") || key.toLowerCase().includes("uri")) {
      format = "uri"
    } else if (key === "id") {
      format = "identifier"
    }
  }

  return { name: key, type, format, required: false }
}

// ============================================================================
// Component
// ============================================================================

/**
 * DataGridSection Component
 *
 * Renders any Wavesmith collection as a data grid with configurable columns.
 * Uses meta-store for column metadata and PropertyRenderer for type-aware cell rendering.
 */
export const DataGridSection = observer(function DataGridSection({
  feature,
  config,
}: SectionRendererProps) {
  const gridConfig = config as DataGridConfig | undefined

  // ============================================================================
  // ALL HOOKS FIRST (React requirement)
  // ============================================================================

  // State for sorting
  const [sortColumn, setSortColumn] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>(null)

  // State for row selection
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)

  // Extract config values
  const schemaName = gridConfig?.schema ?? gridConfig?.schemaName
  const modelName = gridConfig?.model
  // schemaWorkspace is the projectId - used for project-specific schema storage
  const schemaWorkspace = gridConfig?.schemaWorkspace ?? feature?.id
  const configColumns = gridConfig?.columns ?? []
  const excludeColumns = gridConfig?.excludeColumns ?? []
  const title = gridConfig?.title ?? (modelName ? `${modelName} Data` : "Data Grid")
  const stickyFirstColumn = gridConfig?.stickyFirstColumn ?? false
  const onRowSelect = gridConfig?.onRowSelect

  // 1. Get metadata from meta-store (handles async schema loading)
  // Pass schemaWorkspace (projectId) to load from the correct project-specific location
  const { properties: metaProperties, collectionName, loading: metaLoading, error: metaError } =
    useDataGridMetadata(schemaName, modelName, schemaWorkspace)

  // 2. Get data (handles sync vs async internally)
  const { data: rawData, loading: dataLoading, error: dataError } = useDataGridData({
    schemaName,
    collectionName,
    // Default to session filtering when feature is present, unless explicitly disabled
    sessionId: gridConfig?.sessionFilter !== false ? feature?.id : undefined,
    staticFilter: gridConfig?.staticFilter,
    query: gridConfig?.query,
  })

  // 3. Determine columns from config or metadata
  const effectiveColumns = useMemo(() => {
    // Use explicit columns if provided
    if (configColumns.length > 0) return configColumns

    // Auto-detect from metadata
    if (metaProperties.length > 0) {
      const excludeSet = new Set(excludeColumns)
      return metaProperties
        .filter((p: any) => !excludeSet.has(p.name))
        .filter((p: any) => !p.name.startsWith("$") && p.name !== "toJSON")
        .map((p: any) => p.name)
    }

    // Fallback: detect from first data item
    if (rawData.length > 0) {
      const firstItem = rawData[0]
      return Object.keys(firstItem).filter(
        (key) => !key.startsWith("$") && key !== "toJSON"
      )
    }

    return []
  }, [configColumns, excludeColumns, metaProperties, rawData])

  // 4. Build column metadata map (prefer meta-store, fallback to inference)
  const columnMetadataMap = useMemo(() => {
    const map = new Map<string, any>()
    for (const prop of metaProperties) {
      map.set(prop.name, prop)
    }
    return map
  }, [metaProperties])

  // 5. Sort the data
  const sortedData = useMemo(() => {
    return sortData(rawData, sortColumn, sortDirection)
  }, [rawData, sortColumn, sortDirection])

  // Handle column header click for sorting
  const handleHeaderClick = useCallback(
    (column: string) => {
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
    },
    [sortColumn, sortDirection]
  )

  // Handle row click
  const handleRowClick = useCallback(
    (entity: any) => {
      setSelectedRowId(entity.id)
      onRowSelect?.(entity)
    },
    [onRowSelect]
  )

  // ============================================================================
  // RENDER - Early returns after all hooks
  // ============================================================================

  const error = metaError || dataError

  // Handle missing configuration
  if (!schemaName || !modelName) {
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

  // Handle errors
  if (error) {
    return (
      <section data-testid="data-grid-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-destructive/10 rounded-lg text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      </section>
    )
  }

  // Handle loading state (metadata or data loading)
  if (metaLoading || dataLoading) {
    return (
      <section data-testid="data-grid-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </section>
    )
  }

  // Handle empty data
  if (sortedData.length === 0) {
    return (
      <section data-testid="data-grid-section" className="h-full">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          {title}
        </h3>
        <div className="p-4 bg-muted/30 rounded-lg text-center">
          <p className="text-sm text-muted-foreground">No data available</p>
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
                    stickyFirstColumn &&
                      index === 0 &&
                      "sticky left-0 bg-muted/80 backdrop-blur-sm z-10",
                    sortColumn === column && "text-foreground"
                  )}
                >
                  <div className="flex items-center gap-1">
                    <span className="capitalize">
                      {column.replace(/([A-Z])/g, " $1").trim()}
                    </span>
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
                  // Prefer meta-store metadata, fallback to inference
                  const propertyMeta =
                    columnMetadataMap.get(column) ?? inferPropertyMetadata(column, value)

                  return (
                    <td
                      key={column}
                      className={cn(
                        "px-3 py-2",
                        stickyFirstColumn &&
                          index === 0 &&
                          "sticky left-0 bg-background z-10"
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
