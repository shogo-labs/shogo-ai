/**
 * DeleteFeatureDialog Component
 * Task: task-delete-002-alert-dialog
 *
 * Confirmation dialog for deleting a FeatureSession.
 * Uses shadcn Dialog (not AlertDialog) following NewFeatureModal pattern.
 *
 * Props:
 * - open: boolean - Whether the dialog is open
 * - onClose: () => void - Callback when dialog should close
 * - onConfirm: () => void - Callback when user confirms deletion
 * - featureName: string - Name of feature being deleted
 * - isLoading?: boolean - Whether deletion is in progress
 *
 * Features:
 * - Displays feature name in confirmation message
 * - Cancel button closes dialog without action
 * - Delete button triggers onConfirm callback
 * - Loading state shows spinner and disables button
 * - Destructive button styling for delete action
 *
 * Per design decision:
 * - Uses Dialog (not AlertDialog) - AlertDialog is not installed
 * - Built fresh in /components/app/workspace/modals/
 * - Zero imports from /components/Studio/
 */

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

/**
 * Props for DeleteFeatureDialog component
 */
export interface DeleteFeatureDialogProps {
  /** Whether the dialog is open */
  open: boolean
  /** Callback when dialog should close */
  onClose: () => void
  /** Callback when user confirms deletion */
  onConfirm: () => void
  /** Name of the feature being deleted */
  featureName: string
  /** Whether deletion is in progress */
  isLoading?: boolean
}

/**
 * DeleteFeatureDialog Component
 *
 * Renders a confirmation dialog before deleting a feature session.
 * Uses shadcn Dialog with destructive button styling for the delete action.
 */
export function DeleteFeatureDialog({
  open,
  onClose,
  onConfirm,
  featureName,
  isLoading = false,
}: DeleteFeatureDialogProps) {
  /**
   * Handle dialog open state change
   * Only allow closing when not loading
   */
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && !isLoading) {
      onClose()
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Delete Feature</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete "{featureName}"? This action cannot be undone
            and all associated data will be permanently deleted.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              "Delete"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
