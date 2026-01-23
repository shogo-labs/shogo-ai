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
import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { PropertyRenderer } from "@/components/rendering"
import type { PropertyMetadata } from "@/components/rendering"

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
 * PropertyMetadata for test type badge (resolved via registry)
 */
const testTypePropertyMeta: PropertyMetadata = {
  name: "testType",
  type: "string",
  enum: ["unit", "integration", "acceptance"],
  xRenderer: "test-type-badge",
}

/**
 * PropertyMetadata for target file path (resolved via registry)
 */
const targetFilePropertyMeta: PropertyMetadata = {
  name: "targetFile",
  type: "string",
  xRenderer: "code-path",
}

/**
 * PropertyMetadata for given conditions (resolved via registry)
 */
const givenPropertyMeta: PropertyMetadata = {
  name: "given",
  type: "array",
  xRenderer: "string-array",
}

/**
 * PropertyMetadata for then assertions (resolved via registry)
 */
const thenPropertyMeta: PropertyMetadata = {
  name: "then",
  type: "array",
  xRenderer: "string-array",
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
            property={testTypePropertyMeta}
          />
        </div>

        {/* Target file path (via PropertyRenderer) */}
        {spec.targetFile && (
          <div className="mt-2">
            <PropertyRenderer
              value={spec.targetFile}
              property={targetFilePropertyMeta}
            />
          </div>
        )}
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* Given section (via PropertyRenderer) */}
        <div className="p-2 bg-muted/30 rounded-md">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
            Given:
          </span>
          <PropertyRenderer
            value={spec.given}
            property={givenPropertyMeta}
            config={{
              size: "xs",
              layout: "compact",
            }}
          />
        </div>

        {/* When section (single string, keep inline) */}
        <div className="p-2 bg-muted/30 rounded-md">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            When:
          </span>
          <p className="mt-1 text-xs text-foreground pl-4">
            {spec.when}
          </p>
        </div>

        {/* Then section (via PropertyRenderer) */}
        <div className="p-2 bg-muted/30 rounded-md">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">
            Then:
          </span>
          <PropertyRenderer
            value={spec.then}
            property={thenPropertyMeta}
            config={{
              size: "xs",
              layout: "compact",
            }}
          />
        </div>
      </CardContent>
    </Card>
  )
})
