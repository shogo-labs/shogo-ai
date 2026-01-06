/**
 * WorkspaceLayout - Main workspace layout component
 * Tasks: task-2-2-004, task-2-3a-009, task-2-4-005
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
 * Per design-2-2-component-hierarchy:
 * - This is the "smart" component that connects hooks to UI
 * - Child components receive data as props, don't call hooks directly
 *
 * CLEAN BREAK: This file lives in /components/app/workspace/, zero imports from /components/Studio/
 */

import { useState } from "react"
import { Outlet } from "react-router-dom"
import { observer } from "mobx-react-lite"
import { useWorkspaceData } from "./hooks"
import { useWorkspaceNavigation } from "./hooks"
import { PhaseContentPanel } from "../stepper"
import { ChatPanel } from "../chat/ChatPanel"

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
      {/* When feature selected: flex row with gap for side-by-side layout (task-2-4-005) */}
      <div
        className={`flex-1 overflow-auto p-6 ${featureId ? "flex flex-row gap-4" : ""}`}
        data-testid="workspace-content"
      >
        {featureId && currentFeature ? (
          // Feature selected with data - render PhaseContentPanel with ChatPanel (task-2-4-005)
          <ChatPanel
            featureId={featureId}
            featureName={currentFeature.name}
          >
            <div className="flex-1 min-w-0 overflow-auto">
              <PhaseContentPanel feature={currentFeature} />
            </div>
          </ChatPanel>
        ) : featureId ? (
          // Feature ID in URL but no data yet - render Outlet as fallback with ChatPanel
          <ChatPanel
            featureId={featureId}
          >
            <div className="flex-1 min-w-0" data-testid="feature-outlet">
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
