/**
 * CreateWorkspaceModal Component
 * Refactored from CreateOrgModal as part of Organization -> Workspace rename
 *
 * Modal dialog for creating new workspaces.
 * Uses shadcn Dialog component with form validation.
 *
 * Props:
 * - open: boolean - Whether the modal is open
 * - onOpenChange: (open: boolean) => void - Callback when modal open state changes
 * - onSuccess: () => void - Callback when workspace is successfully created
 *
 * Features:
 * - Name (required) and Description (optional) fields
 * - Form validation - name must not be empty
 * - Loading state during creation
 * - Error display if creation fails
 * - Uses MCP domain studioCore.createWorkspace() for persistence
 * - Closes modal and triggers onSuccess callback on success
 *
 * Design:
 * - Uses shadcn Dialog patterns
 * - Follows NewFeatureModal structure for consistency
 * - Creates workspace with current user as owner
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
// Note: Uses legacy domain method studioCore.createWorkspace() - SDK migration pending for action methods
import { useSession } from "@/contexts/SessionProvider"

/**
 * Props for CreateWorkspaceModal component
 */
export interface CreateWorkspaceModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when modal open state changes */
  onOpenChange: (open: boolean) => void
  /** Callback when workspace is successfully created */
  onSuccess?: () => void
}

/**
 * CreateWorkspaceModal Component
 *
 * Renders a dialog for creating new workspaces.
 * Uses shadcn Dialog with form validation, loading, and error states.
 */
export function CreateWorkspaceModal({ open, onOpenChange, onSuccess }: CreateWorkspaceModalProps) {
  // Get studioCore domain for creating workspaces
  const { studioCore } = useDomains()

  // Get current user session
  const { data: session } = useSession()

  // Form state
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Form validation - name is required
  const isValid = name.trim().length > 0

  /**
   * Handle form submission
   * Creates new workspace with current user as owner via MCP domain
   */
  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return

    const userId = session?.user?.id
    if (!userId) {
      setError("You must be logged in to create a workspace")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      // Use domain action to create workspace with owner membership
      await studioCore.createWorkspace(
        name.trim(),
        description.trim() || undefined,
        userId
      )

      // Reset form
      setName("")
      setDescription("")

      // Close modal and notify parent
      onOpenChange(false)
      onSuccess?.()
    } catch (err) {
      console.error("[CreateWorkspaceModal] Failed to create workspace:", err)
      setError(err instanceof Error ? err.message : "Failed to create workspace")
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
      setDescription("")
      setError(null)
    }
    onOpenChange(newOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create Workspace</DialogTitle>
          <DialogDescription>
            Create a new workspace to collaborate with your team.
          </DialogDescription>
        </DialogHeader>

        {/* Error Message */}
        {error && (
          <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-md text-destructive text-sm">
            {error}
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
              <Label htmlFor="workspace-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Acme Corp"
                disabled={isSubmitting}
                autoFocus
              />
              {name.length === 0 && (
                <p className="text-xs text-muted-foreground">Name is required</p>
              )}
            </div>

            {/* Description Field (Optional) */}
            <div className="grid gap-2">
              <Label htmlFor="workspace-description">Description</Label>
              <Textarea
                id="workspace-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of your workspace..."
                disabled={isSubmitting}
                className="min-h-[80px]"
              />
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
            <Button type="submit" disabled={!isValid || isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Workspace"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
