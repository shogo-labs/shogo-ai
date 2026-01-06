/**
 * NewFeatureModal - Modal dialog for creating new feature sessions
 *
 * Follows FeatureControlPlanePage dialog pattern with:
 * - Fixed overlay with z-50 positioning
 * - Name and intent form fields
 * - Project displayed as read-only
 * - Loading and error states
 */

import { useState } from "react"
import { v4 as uuidv4 } from "uuid"

// Inline domains interface to avoid circular dependency in tests
interface Domains {
  platformFeatures: any
  studioCore: any
}

export interface NewFeatureModalProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Callback when modal should close */
  onClose: () => void
  /** Project ID to associate with the new feature */
  projectId: string
  /** Callback when feature is successfully created */
  onFeatureCreated: (feature: any) => void
  /** Required domains - for production use, pass from useDomains() in parent */
  domains: Domains
}

export function NewFeatureModal({
  isOpen,
  onClose,
  projectId,
  onFeatureCreated,
  domains,
}: NewFeatureModalProps) {
  const { platformFeatures, studioCore } = domains

  // Form state
  const [name, setName] = useState("")
  const [intent, setIntent] = useState("")

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Get project details for display
  const project = studioCore.projectCollection.get(projectId)
  const projectName = project?.name || "Unknown Project"

  // Form validation
  const isValid = name.trim().length > 0 && intent.trim().length > 0

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

      // Notify parent and close
      onFeatureCreated(newFeature)
      onClose()
    } catch (err) {
      console.error("[NewFeatureModal] Failed to create feature:", err)
      setError(err instanceof Error ? err.message : "Failed to create feature")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCancel = () => {
    // Reset form state
    setName("")
    setIntent("")
    setError(null)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-feature-modal-title"
    >
      <div className="bg-card border border-border rounded-lg p-6 w-full max-w-md shadow-xl">
        <h2 id="new-feature-modal-title" className="text-lg font-bold mb-4">
          Create New Feature
        </h2>

        {/* Error Message */}
        {error && (
          <div className="p-3 mb-4 bg-red-400/10 border border-red-400/30 rounded-md text-red-400 text-sm">
            Error: {error}
          </div>
        )}

        <div className="space-y-4">
          {/* Project (read-only) */}
          <div>
            <label className="block text-sm font-medium mb-1 text-muted-foreground">
              Project
            </label>
            <div className="px-3 py-2 bg-muted border border-border rounded-md text-sm">
              {projectName}
            </div>
          </div>

          {/* Name Field */}
          <div>
            <label htmlFor="feature-name" className="block text-sm font-medium mb-1">
              Name
            </label>
            <input
              id="feature-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., user-authentication"
              className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              autoFocus
              disabled={isSubmitting}
            />
          </div>

          {/* Intent Field */}
          <div>
            <label htmlFor="feature-intent" className="block text-sm font-medium mb-1">
              Intent
            </label>
            <textarea
              id="feature-intent"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="Describe what this feature should accomplish..."
              className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm resize-none min-h-[100px] focus:outline-none focus:ring-2 focus:ring-primary"
              disabled={isSubmitting}
            />
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3 mt-6">
          <button
            type="button"
            onClick={handleCancel}
            disabled={isSubmitting}
            className="flex-1 py-2 px-4 bg-secondary text-secondary-foreground rounded-md font-medium text-sm hover:bg-secondary/80 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!isValid || isSubmitting}
            className="flex-1 py-2 px-4 bg-primary text-primary-foreground rounded-md font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? "Creating..." : "Create Feature"}
          </button>
        </div>
      </div>
    </div>
  )
}
