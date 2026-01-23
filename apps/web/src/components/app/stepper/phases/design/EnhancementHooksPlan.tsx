/**
 * EnhancementHooksPlan Component
 * Task: task-2-3c-011
 *
 * Displays the enhancement hooks plan for a feature session.
 * Shows the special "enhancement-hooks-plan" design decision in a dedicated view.
 *
 * Per design-2-3c-012:
 * - Wrapped with observer() for MobX reactivity
 * - Queries designDecisionCollection filtered by session and name
 * - Displays decision content and rationale
 */

import { observer } from "mobx-react-lite"
import { useDomains } from "@shogo/app-core"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * Props for EnhancementHooksPlan component
 */
export interface EnhancementHooksPlanProps {
  featureId: string
}

/**
 * EnhancementHooksPlan Component
 *
 * Renders the enhancement hooks plan design decision for the specified feature.
 * This is shown in a separate tab from other design decisions.
 */
export const EnhancementHooksPlan = observer(function EnhancementHooksPlan({
  featureId,
}: EnhancementHooksPlanProps) {
  const { platformFeatures } = useDomains()

  // Query for the enhancement-hooks-plan decision specifically
  const hooksPlan = platformFeatures?.designDecisionCollection
    ?.all()
    .find(
      (d: any) =>
        d.session === featureId && d.name === "enhancement-hooks-plan"
    )

  // Empty state when no plan found
  if (!hooksPlan) {
    return (
      <div
        data-testid="enhancement-hooks-plan"
        className="flex flex-col items-center justify-center p-8 text-center"
      >
        <p className="text-muted-foreground">
          No enhancement hooks plan defined for this feature.
        </p>
      </div>
    )
  }

  return (
    <div data-testid="enhancement-hooks-plan" className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Enhancement Hooks Plan</CardTitle>
          <CardDescription>
            Planned domain enhancements for this feature
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Main decision content */}
          <div>
            <h4 className="text-sm font-medium text-foreground mb-2">
              Enhancements
            </h4>
            <pre className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/50 p-3 rounded-md">
              {hooksPlan.decision}
            </pre>
          </div>

          {/* Rationale explanation */}
          {hooksPlan.rationale && (
            <div>
              <h4 className="text-sm font-medium text-foreground mb-2">
                Rationale
              </h4>
              <p className="text-sm text-muted-foreground">
                {hooksPlan.rationale}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
})
