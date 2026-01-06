/**
 * WorkspaceLayout - Main workspace layout component
 * Task: task-2-2-004
 *
 * Renders the workspace layout with sidebar + content in a flex row.
 * This is the "smart" component that connects useWorkspaceData() hook to UI.
 *
 * Layout structure:
 * - Root: flex h-full
 * - Sidebar: w-64 border-r (256px fixed width)
 * - Content: flex-1 overflow-auto p-6
 *
 * Per design-2-2-layout-architecture:
 * - WorkspaceLayout renders inside AppShell's main area
 * - Sidebar contains FeatureSidebar (placeholder for now)
 * - Content shows ProjectDashboard when no feature selected, Outlet when feature selected
 *
 * Per design-2-2-component-hierarchy:
 * - This is the "smart" component that connects hooks to UI
 * - Child components receive data as props, don't call hooks directly
 *
 * CLEAN BREAK: This file lives in /components/app/workspace/, zero imports from /components/Studio/
 */

import { useState } from "react"
import { Outlet } from "react-router-dom"
import { useWorkspaceData } from "./hooks"
import { useWorkspaceNavigation } from "./hooks"

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
export function WorkspaceLayout() {
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
  const { featureId, projectId } = useWorkspaceNavigation()

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
                    <li key={feature.id} className="text-xs truncate">
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
      <div
        className="flex-1 overflow-auto p-6"
        data-testid="workspace-content"
      >
        {featureId ? (
          // Feature selected - render Outlet for nested routes
          <div data-testid="feature-outlet">
            <Outlet />
          </div>
        ) : (
          // No feature selected - render ProjectDashboard placeholder
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
}
