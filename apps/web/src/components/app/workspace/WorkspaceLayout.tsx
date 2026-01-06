/**
 * WorkspaceLayout - Main workspace layout component
 * Tasks: task-2-2-004, task-2-3a-009, task-2-4-005, task-3-1-007
 *
 * Renders the workspace layout with sidebar + content in a flex row.
 * This is the "smart" component that connects useWorkspaceData() hook to UI.
 *
 * Layout structure:
 * - Root: flex h-full
 * - Sidebar: w-64 border-r (256px fixed width)
 * - Content: flex-1 overflow-auto p-6 (flex row with gap when feature selected)
 *
 * Per design-2-2-layout-architecture:
 * - WorkspaceLayout renders inside AppShell's main area
 * - Sidebar contains FeatureSidebar (placeholder for now)
 * - Content shows ProjectDashboard when no feature selected
 *
 * Per design-2-3a-integration-point (task-2-3a-009):
 * - When featureId is set AND currentFeature exists, render PhaseContentPanel
 * - PhaseContentPanel replaces Outlet placeholder for feature views
 * - WorkspaceLayout remains the smart component boundary
 *
 * Per design-2-4-layout-integration (task-2-4-005):
 * - When featureId is set, render ChatPanel alongside PhaseContentPanel
 * - Content area becomes flex row with gap for side-by-side layout
 * - ChatPanel wraps PhaseContentPanel with ChatContextProvider
 * - ChatPanel manages collapse/expand and width persistence
 *
 * Per design-3-1-realtime-polling (task-3-1-007):
 * - useFeaturePolling called when feature is selected
 * - Polling paused during active chat streaming to avoid conflicts
 * - isPolling indicator visible in sidebar (subtle badge)
 * - refresh function passed to ChatPanel for smart triggers
 *
 * Per design-2-2-component-hierarchy:
 * - This is the "smart" component that connects hooks to UI
 * - Child components receive data as props, don't call hooks directly
 *
 * CLEAN BREAK: This file lives in /components/app/workspace/, zero imports from /components/Studio/
 */

import { useState, useCallback, useEffect, useRef } from "react"
import { Outlet } from "react-router-dom"
import { observer } from "mobx-react-lite"
import { useWorkspaceData } from "./hooks"
import { useWorkspaceNavigation } from "./hooks"
import { useFeaturePolling } from "@/hooks/useFeaturePolling"
import { useToast } from "@/hooks/use-toast"
import { ToastAction } from "@/components/ui/toast"
import { PhaseContentPanel } from "../stepper"
import { ChatPanel } from "../chat/ChatPanel"
import { RefreshCw } from "lucide-react"

/**
 * WorkspaceLayout component
 *
 * Main layout for the workspace area. Uses useWorkspaceData() hook to get
 * workspace state and passes data down to child components.
 *
 * Content area behavior:
 * - No feature selected (featureId is null): Render ProjectDashboard
 * - Feature selected (featureId is set): Render Outlet for feature detail routes
 */
export const WorkspaceLayout = observer(function WorkspaceLayout() {
  // Get workspace data from hook (smart component pattern)
  const {
    orgs,
    currentOrg,
    projects,
    currentProject,
    features,
    currentFeature,
    featuresByPhase,
    isLoading,
  } = useWorkspaceData()

  // Get navigation state for conditional rendering
  const { featureId, projectId, setFeatureId } = useWorkspaceNavigation()

  // Modal state for NewFeatureModal
  // isOpen state passed to modal, onClose callback to close it
  const [isModalOpen, setIsModalOpen] = useState(false)

  // Chat streaming state - tracked here to coordinate with polling (task-3-1-007)
  // When chat is actively streaming, polling should be paused to avoid race conditions
  const [isChatStreaming, setIsChatStreaming] = useState(false)

  // Feature polling hook (task-3-1-007)
  // Polls platform-features domain data when a feature is selected
  // Disabled during chat streaming to avoid conflicts with smart query triggers
  const { isPolling, lastRefresh, refresh, error: pollingError } = useFeaturePolling({
    featureId,
    enabled: !!featureId && !isChatStreaming,
  })

  // Callback for ChatPanel to report streaming state changes
  const handleStreamingChange = useCallback((streaming: boolean) => {
    setIsChatStreaming(streaming)
  }, [])

  // Toast hook for error notifications (task-3-1-009)
  const { toast } = useToast()

  // Track previous error to avoid duplicate toasts
  const prevErrorRef = useRef<Error | null>(null)

  // Show error toast when polling fails (task-3-1-009)
  // Uses useEffect to react to pollingError changes and show toast with retry action
  useEffect(() => {
    // Only show toast if there's a new error (not the same error instance)
    if (pollingError && pollingError !== prevErrorRef.current) {
      prevErrorRef.current = pollingError
      toast({
        variant: "destructive",
        title: "Refresh failed",
        description: pollingError.message || "Could not refresh feature data. Please try again.",
        action: (
          <ToastAction altText="Retry" onClick={() => refresh()}>
            Retry
          </ToastAction>
        ),
        duration: 6000, // Auto-dismiss after 6 seconds
      })
    } else if (!pollingError) {
      // Clear the previous error ref when error is resolved
      prevErrorRef.current = null
    }
  }, [pollingError, refresh, toast])

  // Handlers for modal - onClose callback pattern
  const handleOpenModal = () => setIsModalOpen(true)
  const onClose = () => setIsModalOpen(false)

  return (
    <div className="flex h-full" data-testid="workspace-layout">
      {/* Sidebar area - fixed width with border separator */}
      <aside
        className="w-64 border-r border-border bg-card"
        data-testid="workspace-sidebar"
      >
        {/* FeatureSidebar placeholder - actual component in task-2-2-005 */}
        <div className="p-4">
          {/* Polling status indicator (task-3-1-007) */}
          {featureId && (
            <div className="flex items-center justify-between mb-3 text-xs text-muted-foreground">
              <span>Features</span>
              <div className="flex items-center gap-1.5">
                {isPolling && (
                  <RefreshCw
                    className="h-3 w-3 animate-spin"
                    data-testid="polling-indicator"
                    aria-label="Syncing data"
                  />
                )}
                {lastRefresh && (
                  <span
                    className="text-[10px] opacity-60"
                    title={`Last refresh: ${new Date(lastRefresh).toLocaleTimeString()}`}
                  >
                    {new Date(lastRefresh).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="text-sm text-muted-foreground">
            {/* Features grouped by phase will go here */}
            {Object.entries(featuresByPhase).map(([phase, phaseFeatures]) => (
              <div key={phase} className="mb-4">
                <h3 className="font-semibold capitalize mb-2">{phase}</h3>
                <ul className="space-y-1">
                  {phaseFeatures.map((feature: any) => (
                    <li
                      key={feature.id}
                      className={`text-xs truncate cursor-pointer px-2 py-1 rounded hover:bg-accent ${
                        featureId === feature.id ? "bg-accent font-medium" : ""
                      }`}
                      onClick={() => setFeatureId(feature.id)}
                    >
                      {feature.name}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {/* New Feature button will trigger modal */}
          <button
            onClick={handleOpenModal}
            className="mt-4 w-full px-3 py-2 text-sm bg-primary text-primary-foreground rounded-md"
          >
            New Feature
          </button>
        </div>
      </aside>

      {/* Content area - flexible width with padding and scroll */}
      {/* When feature selected: flex row layout, ChatPanel handles internal side-by-side */}
      <div
        className={`flex-1 min-w-0 overflow-hidden p-6 ${featureId ? "flex" : ""}`}
        data-testid="workspace-content"
      >
        {featureId && currentFeature ? (
          // Feature selected with data - render PhaseContentPanel with ChatPanel (task-2-4-005)
          // ChatPanel takes full width and handles internal flex layout
          // Polling integration (task-3-1-007): pass refresh for smart triggers, track streaming state
          // Loading states (task-3-1-008): pass isPolling for subtle loading overlay
          <ChatPanel
            featureId={featureId}
            featureName={currentFeature.name}
            className="flex-1 min-w-0"
            onRefresh={refresh}
            onStreamingChange={handleStreamingChange}
            isPolling={isPolling}
          >
            <PhaseContentPanel feature={currentFeature} />
          </ChatPanel>
        ) : featureId ? (
          // Feature ID in URL but no data yet - render Outlet as fallback with ChatPanel
          <ChatPanel
            featureId={featureId}
            className="flex-1 min-w-0"
            onRefresh={refresh}
            onStreamingChange={handleStreamingChange}
            isPolling={isPolling}
          >
            <div data-testid="feature-outlet">
              <Outlet />
            </div>
          </ChatPanel>
        ) : (
          // No feature selected - render ProjectDashboard placeholder (no ChatPanel)
          <div data-testid="project-dashboard">
            {/* ProjectDashboard placeholder - actual component in task-2-2-007 */}
            <div className="space-y-4">
              <h2 className="text-2xl font-bold">
                {currentProject?.name || "Select a Project"}
              </h2>
              {currentProject && (
                <div className="grid gap-4">
                  <div className="p-4 bg-card rounded-lg border">
                    <h3 className="font-semibold mb-2">Features Summary</h3>
                    <p className="text-sm text-muted-foreground">
                      {features.length} features in this project
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* NewFeatureModal placeholder - actual component in task-2-2-008 */}
      {isModalOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          data-testid="new-feature-modal"
        >
          <div className="bg-card p-6 rounded-lg shadow-lg max-w-md w-full mx-4">
            <h2 className="text-lg font-semibold mb-4">New Feature</h2>
            <p className="text-sm text-muted-foreground mb-4">
              Create a new feature for project: {projectId || "none"}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm bg-secondary text-secondary-foreground rounded-md"
              >
                Cancel
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})
