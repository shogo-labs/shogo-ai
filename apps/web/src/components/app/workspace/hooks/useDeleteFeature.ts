/**
 * useDeleteFeature Hook
 * Task: task-delete-004-delete-handler
 *
 * Custom hook that manages the delete feature workflow:
 * - Dialog state (open/close)
 * - Loading state during deletion
 * - Error state for failure cases
 * - Calls platformFeatures.deleteFeatureSession() from domain
 * - Handles navigation when deleted feature was selected
 *
 * Per design-2-2-component-hierarchy:
 * - This hook is called at the "smart" component level (WorkspaceLayout or similar)
 * - Provides state and handlers to be passed down to child components
 *
 * Usage:
 * ```tsx
 * const {
 *   deleteFeatureId,
 *   isDeleteDialogOpen,
 *   isDeleting,
 *   deleteError,
 *   openDeleteDialog,
 *   closeDeleteDialog,
 *   confirmDelete,
 * } = useDeleteFeature({ currentFeatureId, onNavigateAway })
 * ```
 */

import { useState, useCallback } from "react"
import { useDomains } from "@/contexts/DomainProvider"

/**
 * Props for useDeleteFeature hook
 */
export interface UseDeleteFeatureProps {
  /** Currently selected feature ID (to check if we need to navigate away) */
  currentFeatureId: string | null
  /** Callback to clear feature selection when deleted feature was selected */
  clearFeature: () => void
}

/**
 * Return type for useDeleteFeature hook
 */
export interface UseDeleteFeatureReturn {
  /** ID of feature pending deletion (null if dialog closed) */
  deleteFeatureId: string | null
  /** Name of feature pending deletion for display in dialog */
  deleteFeatureName: string | null
  /** Whether the delete confirmation dialog is open */
  isDeleteDialogOpen: boolean
  /** Whether deletion is in progress */
  isDeleting: boolean
  /** Error from last delete attempt (null if none) */
  deleteError: Error | null
  /** Open delete dialog for a specific feature */
  openDeleteDialog: (featureId: string, featureName: string) => void
  /** Close delete dialog without deleting */
  closeDeleteDialog: () => void
  /** Confirm and execute deletion */
  confirmDelete: () => Promise<void>
}

/**
 * useDeleteFeature Hook
 *
 * Manages the complete delete feature workflow including dialog state,
 * domain call, navigation handling, and error management.
 */
export function useDeleteFeature({
  currentFeatureId,
  clearFeature,
}: UseDeleteFeatureProps): UseDeleteFeatureReturn {
  // Get domain store for deleteFeatureSession action
  // Note: platformFeatures is optional - not loaded in consumer app
  const { platformFeatures } = useDomains<{ platformFeatures?: any }>()

  // Dialog state - which feature is pending deletion
  const [deleteFeatureId, setDeleteFeatureId] = useState<string | null>(null)
  const [deleteFeatureName, setDeleteFeatureName] = useState<string | null>(null)

  // Loading state during async deletion
  const [isDeleting, setIsDeleting] = useState(false)

  // Error state from failed deletion
  const [deleteError, setDeleteError] = useState<Error | null>(null)

  /**
   * Open delete confirmation dialog for a specific feature
   */
  const openDeleteDialog = useCallback((featureId: string, featureName: string) => {
    setDeleteFeatureId(featureId)
    setDeleteFeatureName(featureName)
    setDeleteError(null) // Clear previous error when opening dialog
  }, [])

  /**
   * Close delete dialog without deleting
   * Also clears any previous error state
   */
  const closeDeleteDialog = useCallback(() => {
    setDeleteFeatureId(null)
    setDeleteFeatureName(null)
    setDeleteError(null)
  }, [])

  /**
   * Confirm and execute deletion
   * Calls domain action, handles navigation, manages error state
   */
  const confirmDelete = useCallback(async () => {
    if (!deleteFeatureId) return

    // Guard: platformFeatures domain must be available
    if (!platformFeatures?.deleteFeatureSession) {
      setDeleteError(new Error("Feature deletion is not available"))
      return
    }

    setIsDeleting(true)
    setDeleteError(null)

    try {
      // Call domain action to delete feature and all child entities
      await platformFeatures.deleteFeatureSession(deleteFeatureId)

      // Check if we need to navigate away (deleted the currently selected feature)
      if (currentFeatureId === deleteFeatureId) {
        clearFeature()
      }

      // Close dialog on success
      setDeleteFeatureId(null)
      setDeleteFeatureName(null)
    } catch (error) {
      // Capture error for display
      setDeleteError(error instanceof Error ? error : new Error("Failed to delete feature"))
    } finally {
      setIsDeleting(false)
    }
  }, [deleteFeatureId, currentFeatureId, platformFeatures, clearFeature])

  return {
    deleteFeatureId,
    deleteFeatureName,
    isDeleteDialogOpen: deleteFeatureId !== null,
    isDeleting,
    deleteError,
    openDeleteDialog,
    closeDeleteDialog,
    confirmDelete,
  }
}
