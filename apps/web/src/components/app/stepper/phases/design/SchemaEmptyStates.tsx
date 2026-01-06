/**
 * SchemaEmptyStates Components
 * Task: task-2-3c-013
 *
 * Empty state and loading components for DesignView Schema tab.
 *
 * Per design-2-3c-008:
 * - Four states: no-schema, not-created, loading, error
 * - Uses shadcn Alert and skeleton patterns
 */

import { Info, AlertTriangle, RefreshCw } from "lucide-react"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Props for SchemaEmptyState component
 */
export interface SchemaEmptyStateProps {
  type: "no-schema" | "not-created" | "error"
  onRetry?: () => void
  errorMessage?: string
}

/**
 * SchemaEmptyState Component
 *
 * Displays appropriate empty state based on type:
 * - no-schema: Feature doesn't define a schema
 * - not-created: Schema not yet created (run design phase)
 * - error: Error loading schema with retry option
 */
export function SchemaEmptyState({ type, onRetry, errorMessage }: SchemaEmptyStateProps) {
  if (type === "no-schema") {
    return (
      <Alert data-testid="schema-empty-state-no-schema">
        <Info className="h-4 w-4" />
        <AlertTitle>No Schema</AlertTitle>
        <AlertDescription>
          This feature does not define a schema. Not all features require schema definitions.
        </AlertDescription>
      </Alert>
    )
  }

  if (type === "not-created") {
    return (
      <Alert data-testid="schema-empty-state-not-created">
        <Info className="h-4 w-4" />
        <AlertTitle>Schema Not Created</AlertTitle>
        <AlertDescription>
          Run design phase to create schema. The schema will be generated based on requirements analysis.
        </AlertDescription>
      </Alert>
    )
  }

  // error state
  return (
    <Alert variant="destructive" data-testid="schema-empty-state-error">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Error Loading Schema</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <span>{errorMessage || "Failed to load schema data. Please try again."}</span>
        {onRetry && (
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            className="w-fit"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

/**
 * SchemaLoadingSkeleton Component
 *
 * Shows skeleton rectangles mimicking graph layout while loading.
 */
export function SchemaLoadingSkeleton() {
  return (
    <div
      data-testid="schema-loading-skeleton"
      className="flex flex-col items-center justify-center h-full gap-8 p-8"
    >
      {/* Top row - single node skeleton */}
      <div className="flex justify-center">
        <div className={cn(
          "w-[180px] h-[80px] rounded-lg",
          "bg-muted animate-pulse"
        )} />
      </div>

      {/* Middle row - two node skeletons */}
      <div className="flex gap-12">
        <div className={cn(
          "w-[180px] h-[80px] rounded-lg",
          "bg-muted animate-pulse"
        )} />
        <div className={cn(
          "w-[180px] h-[80px] rounded-lg",
          "bg-muted animate-pulse"
        )} />
      </div>

      {/* Bottom row - single node skeleton */}
      <div className="flex justify-center">
        <div className={cn(
          "w-[180px] h-[80px] rounded-lg",
          "bg-muted animate-pulse"
        )} />
      </div>

      {/* Loading text */}
      <p className="text-sm text-muted-foreground animate-pulse">
        Loading schema...
      </p>
    </div>
  )
}
