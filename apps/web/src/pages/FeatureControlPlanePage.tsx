/**
 * FeatureControlPlanePage - Unified control plane for feature development
 *
 * Combines:
 * - FeatureSessionSelector: Select/create feature sessions
 * - SkillCycleStepper: Navigate through skill phases
 * - FeatureChatPanel: AI-assisted chat with tool call display
 * - EntityDataPanel: Real-time entity data tracking
 */

import { useState, useEffect, useCallback } from "react"
import { observer } from "mobx-react-lite"
import { FeatureSessionSelector } from "@/components/FeatureControlPlane/FeatureSessionSelector"
import {
  SkillCycleStepper,
  type SkillPhase,
} from "@/components/FeatureControlPlane/SkillCycleStepper"
import { FeatureChatPanel } from "@/components/FeatureControlPlane/FeatureChatPanel"
import { EntityDataPanel } from "@/components/FeatureControlPlane/EntityDataPanel"
import { mcpService } from "@/services/mcpService"

interface FeatureSession {
  id: string
  name: string
  intent: string // Schema uses "intent" not "description"
  status: string // This IS the current phase (discovery, analysis, etc.)
  createdAt: number
}

// Map phase strings to SkillPhase type
const PHASE_MAP: Record<string, SkillPhase> = {
  discovery: "discovery",
  analysis: "analysis",
  classification: "classification",
  design: "design",
  spec: "spec",
  implementation: "implementation",
}

// Determine completed phases based on current phase/status
const getCompletedPhases = (status: string | null): SkillPhase[] => {
  const phases: SkillPhase[] = [
    "discovery",
    "analysis",
    "classification",
    "design",
    "spec",
    "implementation",
  ]
  if (!status) return []

  // If testing or complete, all skill phases are done
  if (status === "testing" || status === "complete") {
    return phases
  }

  const currentIndex = phases.indexOf(status as SkillPhase)
  if (currentIndex === -1) return []

  return phases.slice(0, currentIndex)
}

export const FeatureControlPlanePage = observer(
  function FeatureControlPlanePage() {
    const [selectedSession, setSelectedSession] =
      useState<FeatureSession | null>(null)
    const [showCreateDialog, setShowCreateDialog] = useState(false)
    const [newFeatureName, setNewFeatureName] = useState("")
    const [newFeatureDescription, setNewFeatureDescription] = useState("")
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState<string | null>(null)

    // Initialize MCP session on mount
    useEffect(() => {
      mcpService.initializeSession().catch(console.error)
    }, [])

    // Derive current phase and completed phases from status field
    // Status IS the current phase in the platform-features schema
    const currentPhase = selectedSession?.status
      ? PHASE_MAP[selectedSession.status] || null
      : null
    const completedPhases = getCompletedPhases(selectedSession?.status ?? null)

    // Handle creating new feature session
    const handleCreateFeature = useCallback(async () => {
      if (!newFeatureName.trim()) {
        setCreateError("Feature name is required")
        return
      }

      setCreating(true)
      setCreateError(null)

      try {
        // Load schema first
        await mcpService.callTool("schema.load", { name: "platform-features" })

        // Create new feature session
        const result = await mcpService.callTool("store.create", {
          schema: "platform-features",
          model: "FeatureSession",
          data: {
            id: crypto.randomUUID(),
            name: newFeatureName.trim(),
            description: newFeatureDescription.trim() || newFeatureName.trim(),
            status: "active",
            currentPhase: null,
            createdAt: Date.now(),
          },
        })

        setSelectedSession(result.entity)
        setShowCreateDialog(false)
        setNewFeatureName("")
        setNewFeatureDescription("")
      } catch (err: any) {
        console.error("[FeatureControlPlanePage] Error creating feature:", err)
        setCreateError(err.message || "Failed to create feature")
      } finally {
        setCreating(false)
      }
    }, [newFeatureName, newFeatureDescription])

    // Handle skill phase click (for navigation/viewing)
    const handlePhaseClick = useCallback(
      (phase: SkillPhase) => {
        console.log(
          `[FeatureControlPlanePage] Phase clicked: ${phase} for session ${selectedSession?.id}`
        )
        // Could navigate to phase-specific view or trigger skill
      },
      [selectedSession]
    )

    // Handle skill invocation from chat
    const handleSkillInvoked = useCallback((skillName: string) => {
      console.log(`[FeatureControlPlanePage] Skill invoked: ${skillName}`)
      // Could update UI or trigger refresh
    }, [])

    return (
      <div className="flex flex-col h-[calc(100vh-64px)] bg-background">
        {/* Feature Session Selector */}
        <FeatureSessionSelector
          selectedSessionId={selectedSession?.id || null}
          onSessionSelect={setSelectedSession}
          onCreateNew={() => setShowCreateDialog(true)}
        />

        {/* Skill Cycle Stepper */}
        <SkillCycleStepper
          currentPhase={currentPhase}
          completedPhases={completedPhases}
          onPhaseClick={handlePhaseClick}
        />

        {/* Main Content Area */}
        <div className="flex flex-1 overflow-hidden">
          {/* Chat Panel (2/3 width) */}
          <div className="flex-[2] border-r border-border">
            <FeatureChatPanel
              featureSessionId={selectedSession?.id || null}
              featureSessionName={selectedSession?.name || null}
              onSkillInvoked={handleSkillInvoked}
            />
          </div>

          {/* Entity Data Panel (1/3 width) */}
          <div className="flex-1 min-w-[300px]">
            <EntityDataPanel featureSessionId={selectedSession?.id || null} />
          </div>
        </div>

        {/* Create Feature Dialog */}
        {showCreateDialog && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-card border border-border rounded-lg p-6 w-full max-w-md shadow-xl">
              <h2 className="text-lg font-bold mb-4">Create New Feature</h2>

              {createError && (
                <div className="p-3 mb-4 bg-red-400/10 border border-red-400/30 rounded-md text-red-400 text-sm">
                  {createError}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Feature Name
                  </label>
                  <input
                    type="text"
                    value={newFeatureName}
                    onChange={(e) => setNewFeatureName(e.target.value)}
                    placeholder="e.g., User Authentication"
                    className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Description (optional)
                  </label>
                  <textarea
                    value={newFeatureDescription}
                    onChange={(e) => setNewFeatureDescription(e.target.value)}
                    placeholder="Brief description of the feature..."
                    className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm resize-none min-h-[80px] focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>

              <div className="flex gap-3 mt-6">
                <button
                  onClick={() => {
                    setShowCreateDialog(false)
                    setNewFeatureName("")
                    setNewFeatureDescription("")
                    setCreateError(null)
                  }}
                  className="flex-1 py-2 px-4 bg-secondary text-secondary-foreground rounded-md font-medium text-sm hover:bg-secondary/80 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateFeature}
                  disabled={creating || !newFeatureName.trim()}
                  className="flex-1 py-2 px-4 bg-primary text-primary-foreground rounded-md font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {creating ? "Creating..." : "Create Feature"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }
)
