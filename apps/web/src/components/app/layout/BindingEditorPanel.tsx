/**
 * BindingEditorPanel - Debug panel for editing RendererBindings
 * Task: task-sdr-v2-006
 *
 * A slide-out debug panel that displays all RendererBindings from the
 * componentBuilder domain. Allows editing matchExpression (JSON) and
 * priority (number) for each binding.
 *
 * Features (per ip-sdr-v2-005):
 * - Lists all RendererBindings with name, priority, component name, matchExpression preview
 * - Click binding to open edit form
 * - JSON textarea for matchExpression editing
 * - Number input for priority editing
 * - JSON validation on save
 * - Immediate UI update via MobX reactivity
 * - Keyboard shortcut support via isOpen/onClose props
 *
 * IMPORTANT: Wrapped with observer() for MobX reactivity. When bindings
 * change in the store, the panel re-renders automatically.
 */

import { useState, useCallback, useEffect } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { cn } from "@/lib/utils"
import { X, ChevronRight, Save, AlertCircle } from "lucide-react"

// ============================================================
// Types
// ============================================================

export interface BindingEditorPanelProps {
  /** Whether the panel is visible */
  isOpen: boolean
  /** Callback when panel should close */
  onClose: () => void
}

interface EditState {
  bindingId: string
  matchExpressionJson: string
  priority: number
}

// ============================================================
// Component
// ============================================================

/**
 * BindingEditorPanel component
 *
 * Debug panel for viewing and editing RendererBindings from componentBuilder domain.
 * Slide-out panel from the right side of the screen.
 */
export const BindingEditorPanel = observer(function BindingEditorPanel({
  isOpen,
  onClose,
}: BindingEditorPanelProps) {
  // Access componentBuilder domain from DomainProvider
  const { componentBuilder } = useDomains()

  // Local state for editing
  const [selectedBinding, setSelectedBinding] = useState<string | null>(null)
  const [editState, setEditState] = useState<EditState | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Get all bindings from the collection
  const bindings = componentBuilder?.rendererBindingCollection?.all() ?? []

  // Handle binding click - open edit form
  const handleBindingClick = useCallback((binding: any) => {
    setSelectedBinding(binding.id)
    setEditState({
      bindingId: binding.id,
      matchExpressionJson: JSON.stringify(binding.matchExpression, null, 2),
      priority: binding.priority,
    })
    setError(null)
  }, [])

  // Handle cancel - close edit form
  const handleCancel = useCallback(() => {
    setSelectedBinding(null)
    setEditState(null)
    setError(null)
  }, [])

  // Handle save - validate JSON and update store
  const handleSave = useCallback(async () => {
    if (!editState || !componentBuilder) return

    // Validate JSON
    let parsedMatchExpression: unknown
    try {
      parsedMatchExpression = JSON.parse(editState.matchExpressionJson)
    } catch (err) {
      setError("Invalid JSON: " + (err instanceof Error ? err.message : String(err)))
      return
    }

    // Validate priority
    if (typeof editState.priority !== "number" || isNaN(editState.priority)) {
      setError("Priority must be a valid number")
      return
    }

    // Update the binding in the store
    try {
      const binding = componentBuilder.rendererBindingCollection.get(editState.bindingId)
      if (binding) {
        // Use updateOne from collection (persistence-aware action)
        await componentBuilder.rendererBindingCollection.updateOne(editState.bindingId, {
          matchExpression: parsedMatchExpression,
          priority: editState.priority,
          updatedAt: Date.now(),
        })
      }

      // Close edit form on success
      setSelectedBinding(null)
      setEditState(null)
      setError(null)
    } catch (err) {
      setError("Failed to update binding: " + (err instanceof Error ? err.message : String(err)))
    }
  }, [editState, componentBuilder])

  // Handle keyboard shortcut (Escape to close)
  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedBinding) {
          handleCancel()
        } else {
          onClose()
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [isOpen, selectedBinding, handleCancel, onClose])

  // Don't render if not open
  if (!isOpen) return null

  // Get the currently editing binding
  const editingBinding = selectedBinding
    ? bindings.find((b: any) => b.id === selectedBinding)
    : null

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-card border-l border-border shadow-xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h2 className="text-lg font-semibold">Binding Editor</h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {editingBinding ? (
          // Edit Form
          <div className="p-4 space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <button
                onClick={handleCancel}
                className="hover:text-foreground transition-colors"
              >
                Bindings
              </button>
              <ChevronRight className="h-3 w-3" />
              <span className="text-foreground">{editingBinding.name}</span>
            </div>

            {/* Binding Info */}
            <div className="space-y-2">
              <div className="text-sm">
                <span className="text-muted-foreground">Component: </span>
                <span>{editingBinding.component?.name ?? "Unknown"}</span>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">ID: </span>
                <span className="font-mono text-xs">{editingBinding.id}</span>
              </div>
            </div>

            {/* Error Alert */}
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {/* Priority Input */}
            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Input
                id="priority"
                type="number"
                value={editState?.priority ?? 0}
                onChange={(e) => {
                  if (editState) {
                    setEditState({
                      ...editState,
                      priority: parseInt(e.target.value, 10) || 0,
                    })
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                Higher priority bindings are evaluated first (200 = explicit, 100 = computed, 50 = enum, 30 = format, 10 = type)
              </p>
            </div>

            {/* Match Expression JSON */}
            <div className="space-y-2">
              <Label htmlFor="matchExpression">Match Expression (JSON)</Label>
              <Textarea
                id="matchExpression"
                value={editState?.matchExpressionJson ?? ""}
                onChange={(e) => {
                  if (editState) {
                    setEditState({
                      ...editState,
                      matchExpressionJson: e.target.value,
                    })
                  }
                }}
                className="font-mono text-xs min-h-[200px]"
                placeholder='{"type": "string"}'
              />
              <p className="text-xs text-muted-foreground">
                MongoDB-style query object for matching PropertyMetadata
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <Button variant="outline" onClick={handleCancel}>
                Cancel
              </Button>
              <Button onClick={handleSave}>
                <Save className="h-4 w-4 mr-2" />
                Save
              </Button>
            </div>
          </div>
        ) : (
          // Binding List
          <div className="divide-y divide-border">
            {bindings.length === 0 ? (
              <div className="p-4 text-center text-muted-foreground">
                No bindings found
              </div>
            ) : (
              bindings.map((binding: any) => (
                <button
                  key={binding.id}
                  onClick={() => handleBindingClick(binding)}
                  className={cn(
                    "w-full text-left p-4 hover:bg-secondary/50 transition-colors",
                    "focus:outline-none focus:bg-secondary/50"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{binding.name}</div>
                      <div className="text-sm text-muted-foreground truncate">
                        {binding.component?.name ?? "Unknown component"}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono bg-secondary px-2 py-1 rounded">
                        P:{binding.priority}
                      </span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground font-mono truncate">
                    {JSON.stringify(binding.matchExpression).slice(0, 50)}
                    {JSON.stringify(binding.matchExpression).length > 50 && "..."}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-border">
        <div className="text-xs text-muted-foreground">
          {bindings.length} binding{bindings.length !== 1 && "s"} total
          <span className="mx-2">|</span>
          Press <kbd className="px-1 py-0.5 bg-secondary rounded text-xs">Esc</kbd> to close
        </div>
      </div>
    </div>
  )
})
