/**
 * CreateProjectModal Component
 *
 * Modal dialog for creating new projects within a workspace.
 * Uses shadcn Dialog component with form validation.
 *
 * Props:
 * - open: boolean - Whether the modal is open
 * - onOpenChange: (open: boolean) => void - Callback when modal open state changes
 * - workspaceId: string - The ID of the workspace to create the project in
 * - onSuccess: () => void - Callback when project is successfully created
 *
 * Features:
 * - Name (required) and Description (optional) fields
 * - Form validation - name must not be empty
 * - Loading state during creation
 * - Error display if creation fails
 * - Uses MCP domain studioCore.createProject() for persistence
 * - Closes modal and triggers onSuccess callback on success
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
import { useSession } from "@/contexts/SessionProvider"

/**
 * Props for CreateProjectModal component
 */
export interface CreateProjectModalProps {
  /** Whether the modal is open */
  open: boolean
  /** Callback when modal open state changes */
  onOpenChange: (open: boolean) => void
  /** The ID of the workspace to create the project in */
  workspaceId: string
  /** Callback when project is successfully created, receives the new project ID */
  onSuccess?: (projectId: string) => void
}

/**
 * CreateProjectModal Component
 *
 * Renders a dialog for creating new projects.
 * Uses shadcn Dialog with form validation, loading, and error states.
 */
export function CreateProjectModal({ open, onOpenChange, workspaceId, onSuccess }: CreateProjectModalProps) {
  // Get studioCore domain for creating projects
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
   * Creates new project in the workspace via MCP domain
   */
  const handleSubmit = async () => {
    if (!isValid || isSubmitting) return

    const userId = session?.user?.id
    if (!userId) {
      setError("You must be logged in to create a project")
      return
    }

    if (!workspaceId) {
      setError("No workspace selected")
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      // Use domain action to create project
      const newProject = await studioCore.createProject(
        name.trim(),
        workspaceId,
        description.trim() || undefined,
        userId
      )

      // Reset form
      setName("")
      setDescription("")

      // Close modal and notify parent with the new project ID
      onOpenChange(false)
      onSuccess?.(newProject.id)
    } catch (err) {
      console.error("[CreateProjectModal] Failed to create project:", err)
      setError(err instanceof Error ? err.message : "Failed to create project")
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
          <DialogTitle>Create Project</DialogTitle>
          <DialogDescription>
            Create a new project in this workspace.
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
              <Label htmlFor="project-name">
                Name <span className="text-destructive">*</span>
              </Label>
              <Input
                id="project-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., My New App"
                disabled={isSubmitting}
                autoFocus
              />
              {name.length === 0 && (
                <p className="text-xs text-muted-foreground">Name is required</p>
              )}
            </div>

            {/* Description Field (Optional) */}
            <div className="grid gap-2">
              <Label htmlFor="project-description">Description</Label>
              <Textarea
                id="project-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="A brief description of your project..."
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
                "Create Project"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
