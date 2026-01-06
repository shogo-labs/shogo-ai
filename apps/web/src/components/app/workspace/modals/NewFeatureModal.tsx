/**
 * NewFeatureModal Component
 * Task: task-2-2-006
 *
 * Modal dialog for creating new FeatureSession entities.
 * Uses shadcn Dialog component with form validation.
 *
 * Props:
 * - open: boolean - Whether the modal is open
 * - onOpenChange: (open: boolean) => void - Callback when modal open state changes
 * - projectId: string - Project ID to associate with the new feature
 *
 * Features:
 * - Name (required) and Intent (textarea) fields
 * - Form validation - name must not be empty
 * - Loading state during creation
 * - Error display if creation fails
 * - Auto-selects new feature after creation via setFeatureId
 *
 * Per design-2-2-clean-break:
 * - Built fresh in /components/app/workspace/modals/
 * - Uses shadcn Dialog patterns
 * - Zero imports from /components/Studio/
 */

import { useState } from "react"
import { v4 as uuidv4 } from "uuid"
import { Loader2 } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { useDomains } from "@/contexts/DomainProvider"
import { useWorkspaceNavigation } from "../hooks/useWorkspaceNavigation"

/**
 * Props for NewFeatureModal component
 */
export interface NewFeatureModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when modal open state changes */
  onOpenChange: (open: boolean) => void
  /** Project ID to associate with the new feature */
  projectId: string
}

/**
 * NewFeatureModal Component
 *
 * Renders a dialog for creating new FeatureSession entities.
 * Uses shadcn Dialog with form validation, loading, and error states.
 */
export function NewFeatureModal({
  open,
  onOpenChange,
  projectId,
}: NewFeatureModalProps) {
  // Domain access
  const { platformFeatures } = useDomains()
  const { setFeatureId } = useWorkspaceNavigation()

  // Form state
  const [name, setName] = useState("")
  const [intent, setIntent] = useState("")

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form validation - name is required
  const isValid = name.trim().length > 0

  /**
   * Handle form submission
   * Creates new FeatureSession and navigates to it
   */
  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return

    setIsSubmitting(true)
    setError(null)

    try {
      const featureData = {
        id: uuidv4(),
        name: name.trim(),
        intent: intent.trim(),
        status: "discovery" as const,
        project: projectId,
        affectedPackages: [],
        createdAt: Date.now(),
      }

      const newFeature = await platformFeatures.featureSessionCollection.insertOne(featureData)

      // Reset form
      setName("")
      setIntent("")

      // Close modal
      onOpenChange(false)

      // Navigate to new feature
      await setFeatureId(newFeature.id)
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
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create New Feature</DialogTitle>
        </DialogHeader>

        {/* Error Message */}
        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm">
            {error}
          </div>
        )}

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
              placeholder="e.g., user-authentication"
              disabled={isSubmitting}
              autoFocus
            />
            {name.length === 0 && (
              <p className="text-xs text-muted-foreground">Name is required</p>
            )}
          </div>

          {/* Intent Field */}
          <div className="grid gap-2">
            <Label htmlFor="feature-intent">Intent</Label>
            <Textarea
              id="feature-intent"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="Describe what this feature should accomplish..."
              disabled={isSubmitting}
              className="min-h-[100px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting}
          >
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
      </DialogContent>
    </Dialog>
  )
}
