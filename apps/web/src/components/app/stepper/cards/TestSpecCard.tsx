/**
 * TestSpecCard Component
 * Task: task-2-3d-test-spec-card
 *
 * Displays a single TestSpecification entity with Given/When/Then sections
 * and testType badge.
 *
 * Props:
 * - spec: TestSpecification object with scenario, given[], when, then[], testType, targetFile
 *
 * Per design-2-3d-component-hierarchy:
 * - Built in /components/app/stepper/cards/
 * - Wrapped with observer() for MobX reactivity
 *
 * Per Phase 2 integration:
 * - Uses PropertyRenderer for testType badge
 */

import { observer } from "mobx-react-lite"
import { cva, type VariantProps } from "class-variance-authority"
import { FileCode } from "lucide-react"
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { PropertyRenderer } from "@/components/rendering"

/**
 * Test type enum - matches TestSpecification entity
 */
export type TestType = "unit" | "integration" | "acceptance"

/**
 * TestSpecification type for card display
 */
export interface TestSpec {
  id: string
  scenario: string
  given: string[]
  when: string
  then: string[]
  testType: TestType
  targetFile?: string
}

/**
 * Props for TestSpecCard component
 */
export interface TestSpecCardProps {
  /** Test specification to display */
  spec: TestSpec
}

/**
 * CVA variants for test type badge styling
 * Maps test type to visual styling
 */
export const testTypeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      type: {
        unit: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
        integration: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
        acceptance: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
      },
    },
    defaultVariants: {
      type: "unit",
    },
  }
)

/**
 * Get display label for test type
 */
function getTypeLabel(type: TestType): string {
  const labels: Record<TestType, string> = {
    unit: "Unit",
    integration: "Integration",
    acceptance: "Acceptance",
  }
  return labels[type] || type
}

/**
 * TestSpecCard Component
 *
 * Renders a single test specification with:
 * - Scenario name in header with test type badge
 * - Optional targetFile path with monospace font
 * - Given/When/Then sections in muted backgrounds
 */
export const TestSpecCard = observer(function TestSpecCard({
  spec,
}: TestSpecCardProps) {
  return (
    <Card
      data-testid={`test-spec-card-${spec.id}`}
      className={cn(
        "transition-all",
        "hover:shadow-md hover:border-primary/50"
      )}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-foreground line-clamp-2">
              {spec.scenario}
            </h4>
          </div>
          {/* Use PropertyRenderer for test type badge */}
          <PropertyRenderer
            value={spec.testType}
            property={{
              name: "testType",
              type: "string",
              xRenderer: "test-type-badge",
            }}
          />
        </div>

        {/* Target file path */}
        {spec.targetFile && (
          <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
            <FileCode className="h-3 w-3" />
            <span className="font-mono truncate">{spec.targetFile}</span>
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* Given section */}
        <div className="p-2 bg-muted/30 rounded-md">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Given:
          </span>
          <ul className="mt-1 space-y-0.5 pl-4">
            {spec.given.map((item, index) => (
              <li key={index} className="text-xs text-foreground list-disc">
                {item}
              </li>
            ))}
          </ul>
        </div>

        {/* When section */}
        <div className="p-2 bg-muted/30 rounded-md">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            When:
          </span>
          <p className="mt-1 text-xs text-foreground pl-4">
            {spec.when}
          </p>
        </div>

        {/* Then section */}
        <div className="p-2 bg-muted/30 rounded-md">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Then:
          </span>
          <ul className="mt-1 space-y-0.5 pl-4">
            {spec.then.map((item, index) => (
              <li key={index} className="text-xs text-foreground list-disc">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
})
