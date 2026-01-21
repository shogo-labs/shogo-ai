/**
 * WorkspaceLayout - Main workspace layout component
 * Tasks: task-2-2-004, task-2-3a-009, task-2-4-005, task-3-1-007, task-cpbi-004, task-delete-005, task-dcb-012
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
 * Per design-delete-feature-integration (task-delete-005):
 * - useDeleteFeature hook called at WorkspaceLayout level
 * - DeleteFeatureDialog rendered with state from hook
 * - FeatureSidebar receives onDeleteFeature handler
 * - Handles navigation when deleted feature was selected
 *
 * Per dynamic-component-builder-vision (task-dcb-012):
 * - ComponentCatalogSidebar integrated below FeatureSidebar
 * - Collapsible section with 'Components' header
 * - Collapse state persisted to localStorage
 * - Visual separator (border-t) between sections
 * - Both sections share sidebar scroll container
 *
 * Per design-2-2-component-hierarchy:
 * - This is the "smart" component that connects hooks to UI
 * - Child components receive data as props, don't call hooks directly
 *
 * CLEAN BREAK: This file lives in /components/app/workspace/, zero imports from /components/Studio/
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { Outlet, useNavigate } from "react-router-dom"
import { observer } from "mobx-react-lite"
import { useWorkspaceData, useWorkspaceNavigation, useDeleteFeature } from "./hooks"
import { useDomains } from "@/contexts/DomainProvider"
import { useSession } from "@/auth/client"
import { usePhaseNavigation } from "../stepper/hooks/usePhaseNavigation"
import { useToast } from "@/hooks/use-toast"
import { PhaseContentPanel } from "../stepper"
import { ChatPanel } from "../chat/ChatPanel"
import { FeatureSidebar } from "./sidebar"
import { HomePage } from "./dashboard"
import { DeleteFeatureDialog } from "./modals/DeleteFeatureDialog"
import { NewFeatureModal } from "./modals/NewFeatureModal"
import { useHomeToWorkspaceTransition } from "@/hooks/useHomeToWorkspaceTransition"
import { useSidebarCollapseContext } from "../layout/AppShell"

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
/**
 * Generate a project name from a prompt using a small language model.
 * Calls the /api/generate-project-name endpoint which uses Claude to create
 * a meaningful, concise project name from the user's description.
 * 
 * Falls back to a simple extraction if the API call fails.
 */
async function generateProjectNameFromPrompt(prompt: string): Promise<string> {
  try {
    const response = await fetch('/api/generate-project-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    
    const data = await response.json()
    
    if (data.name && typeof data.name === 'string') {
      return data.name
    }
    
    // Fallback if response doesn't have a name
    return fallbackGenerateProjectName(prompt)
  } catch (error) {
    console.warn('[generateProjectNameFromPrompt] API call failed, using fallback:', error)
    return fallbackGenerateProjectName(prompt)
  }
}

/**
 * Fallback name generation using simple string extraction.
 * Used when the API call fails or is unavailable.
 */
function fallbackGenerateProjectName(prompt: string): string {
  const fillerWords = new Set([
    "a", "an", "the", "to", "for", "with", "that", "this", "is", "are",
    "create", "build", "make", "design", "develop", "implement",
    "please", "can", "you", "i", "want", "need", "would", "like",
    "simple", "basic", "web", "app", "application", "website", "page"
  ])
  
  const words = prompt.toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(word => word.length > 2 && !fillerWords.has(word))
  
  const nameWords = words.slice(0, 3)
  
  if (nameWords.length === 0) {
    return "New Project"
  }
  
  return nameWords
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

export const WorkspaceLayout = observer(function WorkspaceLayout() {
  // React Router navigation for /projects/:id route
  const navigate = useNavigate()
  
  // Get workspace data from hook (smart component pattern)
  const {
    currentWorkspace,
    projects,
    currentProject,
    features,
    currentFeature,
    featuresByPhase,
    isLoading,
    refetchProjects,
  } = useWorkspaceData()

  // Get navigation state for conditional rendering
  const { featureId, projectId, setFeatureId, setProjectId, clearFeature } = useWorkspaceNavigation()
  
  // Get domains for creating projects, features, and chat sessions
  const { studioCore, platformFeatures, studioChat } = useDomains()

  // Get sidebar collapse control for homepage transition animation
  const { collapseSidebar } = useSidebarCollapseContext()

  // Get user session
  const { data: session } = useSession()

  // Get phase navigation state (task-cpbi-004)
  // Pass feature status as fallback when feature is loaded, otherwise "discovery"
  const { phase } = usePhaseNavigation(currentFeature?.status ?? "discovery")

  // Delete feature hook (task-delete-005)
  // Manages dialog state, deletion, and navigation when deleted feature was selected
  const {
    deleteFeatureName,
    isDeleteDialogOpen,
    isDeleting,
    openDeleteDialog,
    closeDeleteDialog,
    confirmDelete,
  } = useDeleteFeature({
    currentFeatureId: featureId,
    clearFeature,
  })

  // Handler to open delete dialog with feature ID and name
  // Maps from feature ID (from sidebar) to feature name (for dialog display)
  const handleDeleteFeature = useCallback(
    (featureIdToDelete: string) => {
      // Find the feature in our features list to get its name
      const feature = features.find((f: any) => f.id === featureIdToDelete)
      if (feature) {
        openDeleteDialog(featureIdToDelete, feature.name)
      }
    },
    [features, openDeleteDialog]
  )

  // Modal state for NewFeatureModal
  // isOpen state passed to modal, onClose callback to close it
  const [isModalOpen, setIsModalOpen] = useState(false)

  // Toast hook for notifications
  const { toast } = useToast()

  // Handlers for modal - onClose callback pattern
  const handleOpenModal = () => setIsModalOpen(true)
  const onClose = () => setIsModalOpen(false)
  
  // State for prompt submission (creating project from home page)
  const [isCreatingFromPrompt, setIsCreatingFromPrompt] = useState(false)

  // Store navigation data during handlePromptSubmit for use in transition callback
  const navigationDataRef = useRef<{
    project: any
    chatSessionId: string
    prompt: string
  } | null>(null)

  // Ref for the home page input card (used for capturing start position before navigation)
  const inputCardRef = useRef<HTMLDivElement>(null)

  // Navigation callback for transition - navigates to ProjectLayout with state
  // Captures the input position and passes it for overlay animation
  const handleTransitionNavigate = useCallback(() => {
    const data = navigationDataRef.current
    if (!data) {
      console.error("[WorkspaceLayout] No navigation data available for transition")
      return
    }

    // Capture the input position for transition animation
    const startRect = inputCardRef.current?.getBoundingClientRect()
    const serializedStartRect = startRect ? {
      top: startRect.top,
      left: startRect.left,
      width: startRect.width,
      height: startRect.height,
      right: startRect.right,
      bottom: startRect.bottom,
    } : null

    navigate(`/projects/${data.project.id}?chatSessionId=${data.chatSessionId}`, {
      state: {
        project: data.project,
        chatSessionId: data.chatSessionId,
        initialMessage: data.prompt,
        // Pass transition data for overlay animation
        transitionStartRect: serializedStartRect,
        transitionPromptText: data.prompt,
      },
    })
  }, [navigate])

  // Home to workspace transition animation state (with FLIP animation support)
  const {
    transitionPhase,
    pendingPrompt,
    startTransition,
    isComplete: isTransitionComplete,
    flipStyle,
  } = useHomeToWorkspaceTransition({
    onSidebarCollapse: collapseSidebar,
    onNavigate: handleTransitionNavigate,
    inputRef: inputCardRef,
  })

  /**
   * Handle prompt submission from home page
   * Creates project and chat session, then triggers animated transition to ProjectLayout.
   */
  const handlePromptSubmit = useCallback(async (prompt: string) => {
    const userId = session?.user?.id
    const workspaceId = currentWorkspace?.id

    if (!userId || !workspaceId) {
      console.error("[WorkspaceLayout] Cannot create from prompt: missing userId or workspaceId")
      return
    }

    if (!studioCore || !studioChat) {
      console.error("[WorkspaceLayout] Cannot create from prompt: domains not available")
      return
    }

    setIsCreatingFromPrompt(true)

    try {
      // 1. Generate a project name from the prompt using AI
      const projectName = await generateProjectNameFromPrompt(prompt)

      // 2. Create the project
      const newProject = await studioCore.createProject(
        projectName,
        workspaceId,
        prompt, // Use the full prompt as description
        userId
      )

      // 3. Create a chat session for this project
      const chatSession = await studioChat.createChatSession({
        inferredName: `Chat - ${projectName}`,
        contextType: "project",
        contextId: newProject.id,
      })

      // 4. Store navigation data for the transition callback
      navigationDataRef.current = {
        project: newProject,
        chatSessionId: chatSession.id,
        prompt,
      }

      // 5. Trigger refetch so the project shows in the sidebar
      refetchProjects()

      // 6. Start the animated transition (collapses sidebar, then navigates)
      await startTransition(prompt)

    } catch (error) {
      console.error("[WorkspaceLayout] Failed to create from prompt:", error)
      navigationDataRef.current = null
    } finally {
      setIsCreatingFromPrompt(false)
    }
  }, [session?.user?.id, currentWorkspace?.id, studioCore, studioChat, refetchProjects, startTransition])

  // Determine if we're on the home view (no project selected)
  const isHomeView = !currentProject && !projectId

  return (
    <div className="flex h-full" data-testid="workspace-layout">
      {/* Sidebar area - only show when a project is selected (not on home view) */}
      {!isHomeView && (
        <aside
          className="w-64 border-r border-border bg-card flex flex-col"
          data-testid="workspace-sidebar"
        >
          {/* Scrollable container for both sidebar sections (task-dcb-012) */}
          <div
            className="flex-1 overflow-y-auto"
            data-testid="sidebar-scroll-container"
          >
            {/* FeatureSidebar with delete support (task-delete-005) */}
            <FeatureSidebar
              featuresByPhase={featuresByPhase}
              currentFeatureId={featureId}
              onFeatureSelect={setFeatureId}
              onNewFeature={handleOpenModal}
              projectId={projectId}
              onDeleteFeature={handleDeleteFeature}
            />
          </div>
        </aside>
      )}

      {/* Content area - flexible width, full-width layout (task-testbed-full-width) */}
      {/* When feature selected: flex row layout, ChatPanel handles internal side-by-side */}
      {/* NOTE: p-6 padding removed to enable full-width content for both /app and /app/advanced-chat */}
      <div
        className={`flex-1 min-w-0 overflow-hidden ${featureId ? "flex" : ""}`}
        data-testid="workspace-content"
      >
        {featureId && currentFeature ? (
          // Feature selected with data - render PhaseContentPanel with ChatPanel (task-2-4-005)
          // ChatPanel takes full width and handles internal flex layout
          // Phase prop threading (task-cpbi-004): pass phase from usePhaseNavigation
          // credit-tracking: pass workspaceId and userId for billing
          <ChatPanel
            featureId={featureId}
            featureName={currentFeature.name}
            phase={phase}
            workspaceId={currentWorkspace?.id}
            userId={session?.user?.id}
            className="flex-1 min-w-0"
          >
            <PhaseContentPanel feature={{ ...currentFeature, projectId }} />
          </ChatPanel>
        ) : featureId ? (
          // Feature ID in URL but no data yet - render Outlet as fallback with ChatPanel
          // credit-tracking: pass workspaceId and userId for billing
          <ChatPanel
            featureId={featureId}
            phase={phase}
            workspaceId={currentWorkspace?.id}
            userId={session?.user?.id}
            className="flex-1 min-w-0"
          >
            <div data-testid="feature-outlet">
              <Outlet />
            </div>
          </ChatPanel>
        ) : (
          // No feature selected - render HomePage, ComposingWorkspaceView, or ProjectDashboard
          <div data-testid="project-dashboard" className="h-full">
            {currentProject ? (
              // Project selected but no feature - show project summary
              <div className="p-6 space-y-4">
                <h2 className="text-2xl font-bold">{currentProject.name}</h2>
                <div className="grid gap-4">
                  <div className="p-4 bg-card rounded-lg border">
                    <h3 className="font-semibold mb-2">Features Summary</h3>
                    <p className="text-sm text-muted-foreground">
                      {features.length} features in this project
                    </p>
                  </div>
                </div>
              </div>
            ) : transitionPhase !== "idle" ? (
              // Transition is in progress (commit/dissolve/transform) - show HomePage with FLIP animation
              // At transform phase completion, navigation happens and this component unmounts
              <HomePage
                userName={session?.user?.name?.split(" ")[0] || "there"}
                onPromptSubmit={handlePromptSubmit}
                isLoading={true}
                transitionPhase={transitionPhase}
                inputRef={inputCardRef}
                flipStyle={flipStyle}
              />
            ) : (
              // No project selected, no transition - show engaging home page
              // Use user's first name for greeting (like Lovable), fallback to "there"
              <HomePage
                userName={session?.user?.name?.split(" ")[0] || "there"}
                onPromptSubmit={handlePromptSubmit}
                isLoading={isCreatingFromPrompt}
                inputRef={inputCardRef}
              />
            )}
          </div>
        )}
      </div>

      {/* NewFeatureModal - creates features and navigates to them */}
      <NewFeatureModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        projectId={projectId}
        onSuccess={(newFeatureId) => {
          // Navigate to the newly created feature
          setFeatureId(newFeatureId)
        }}
      />

      {/* Delete feature confirmation dialog (task-delete-005) */}
      <DeleteFeatureDialog
        open={isDeleteDialogOpen}
        onClose={closeDeleteDialog}
        onConfirm={confirmDelete}
        featureName={deleteFeatureName ?? ""}
        isLoading={isDeleting}
      />
    </div>
  )
})
