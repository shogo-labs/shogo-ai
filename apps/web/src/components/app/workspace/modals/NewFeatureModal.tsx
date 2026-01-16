/**
 * NewFeatureModal Component
 *
 * Modal dialog for creating new features within a project.
 * Uses shadcn Dialog component with form validation.
 *
 * Props:
 * - open: boolean - Whether the modal is open
 * - onOpenChange: (open: boolean) => void - Callback when modal open state changes
 * - projectId: string - The ID of the project to create the feature in
 * - onSuccess: (featureId: string) => void - Callback when feature is successfully created
 *
 * Features:
 * - Name (required) and Intent/Description (required) fields
 * - Form validation
 * - Loading state during creation
 * - Error display if creation fails
 * - Uses MCP domain platformFeatures.createFeatureSession() for persistence
 */

import { useState } from "react"
import { Loader2 } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { useDomains } from "@/contexts/DomainProvider"

/**
 * Props for NewFeatureModal component
 */
export interface NewFeatureModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when modal open state changes */
  onOpenChange: (open: boolean) => void
  /** The ID of the project to create the feature in */
  projectId: string | null
  /** Callback when feature is successfully created, receives the new feature ID */
  onSuccess?: (featureId: string) => void
}

/**
 * NewFeatureModal Component
 *
 * Renders a dialog for creating new features.
 * Uses shadcn Dialog with form validation, loading, and error states.
 */
export function NewFeatureModal({ open, onOpenChange, projectId, onSuccess }: NewFeatureModalProps) {
  // Get platformFeatures domain for creating features
  const { platformFeatures } = useDomains()

  // Form state
  const [name, setName] = useState("")
  const [intent, setIntent] = useState("")

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form validation - name and intent are required
  const isValid = name.trim().length > 0 && intent.trim().length > 0

  /**
   * Handle form submission
   * Creates new feature in the project via MCP domain
   */
  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return

    if (!projectId) {
      setError("No project selected. Please select a project first.")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      // Use domain action to create feature session
      const newFeature = await platformFeatures.createFeatureSession({
        name: name.trim(),
        intent: intent.trim(),
        project: projectId,
      })

      // Reset form
      setName("")
      setIntent("")

      // Close modal and notify parent with the new feature ID
      onOpenChange(false)
      onSuccess?.(newFeature.id)
    } catch (err) {
      console.error("[NewFeatureModal] Failed to create feature:", err)
      setError(err instanceof Error ? err.message : "Failed to create feature")
    } finally {
      setIsSubmitting(false)
    }
  }

  /**
   * Handle modal close - reset form state
   */
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      // Reset form when closing
      setName("")
      setIntent("")
      setError(null)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>New Feature</DialogTitle>
          <DialogDescription>
            Create a new feature to start the development workflow.
          </DialogDescription>
        </DialogHeader>

        {/* Error Message */}
        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm">
            {error}
          </div>
        )}

        {/* No project selected warning */}
        {!projectId && (
          <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-md text-yellow-600 dark:text-yellow-400 text-sm">
            Please select a project first before creating a feature.
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSubmit()
          }}
        >
          <div className="grid gap-4 py-4">
            {/* Name Field (Required) */}
            <div className="grid gap-2">
              <Label htmlFor="feature-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="feature-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., User Authentication"
                disabled={isSubmitting || !projectId}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                A short, descriptive name for this feature
              </p>
            </div>

            {/* Intent/Description Field (Required) */}
            <div className="grid gap-2">
              <Label htmlFor="feature-intent">
                What do you want to build? <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="feature-intent"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="Describe what you want to build. Be specific about the functionality, user interactions, and expected behavior..."
                disabled={isSubmitting || !projectId}
                className="min-h-[120px]"
              />
              <p className="text-xs text-muted-foreground">
                This will guide the AI through discovery, design, and implementation
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!isValid || isSubmitting || !projectId}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Feature"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
