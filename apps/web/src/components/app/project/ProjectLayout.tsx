/**
 * ProjectLayout - Main project view layout (Lovable.dev-inspired)
 *
 * Full-screen project editing experience with:
 * - Minimal top bar with project name dropdown, preview controls, and actions
 * - Split view: Chat/History panel (LEFT) + Dynamic workspace/preview (RIGHT)
 * - Toggle between chat and history views
 * - Hide/show left panel entirely
 *
 * Key features:
 * - Chat is on the LEFT side like Lovable.dev
 * - History panel replaces chat when toggled
 * - Preview has subtle border/shadow styling
 */

import { observer } from "mobx-react-lite"
import { useEffect, useCallback, useState, useRef } from "react"
import { useParams, useLocation, useNavigate } from "react-router-dom"
import { useDomains } from "@/contexts/DomainProvider"
import { ComposablePhaseView } from "@/components/rendering/composition/ComposablePhaseView"
import { ComponentRegistryProvider } from "@/components/rendering"
import { createRegistryFromDomain } from "@/components/rendering/registryFactory"
import { ChatPanel } from "../chat/ChatPanel"
import { ChatPanelTransitionOverlay } from "../chat/ChatPanelTransitionOverlay"
import { useChatSessionNavigation } from "../advanced-chat/hooks/useChatSessionNavigation"
import { ProjectTopBar } from "./ProjectTopBar"
import { ChatSessionsPanel, type ChatSessionItem } from "./ChatSessionsPanel"
import { RuntimePreviewPanel } from "./RuntimePreviewPanel"
import { CodeEditorPanel } from "./CodeEditorPanel"
import { cn } from "@/lib/utils"
import { useSession } from "@/auth/client"
import type { ViewportSize } from "./PreviewControls"

const WORKSPACE_COMPOSITION_NAME = "workspace"

// Default chat panel width in px
const DEFAULT_CHAT_WIDTH = 480

// Serialized rect for transition animation
interface SerializedRect {
  top: number
  left: number
  width: number
  height: number
  right: number
  bottom: number
}

// Location state passed from homepage transition
interface TransitionLocationState {
  project?: any
  chatSessionId?: string
  initialMessage?: string
  // Transition animation data
  transitionStartRect?: SerializedRect
  transitionPromptText?: string
}

export const ProjectLayout = observer(function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { data: session } = useSession()

  // Extract state passed from homepage transition (for instant render + warm-start)
  const transitionState = location.state as TransitionLocationState | null

  const { platformFeatures, componentBuilder, studioChat, studioCore, billing } = useDomains<{
    platformFeatures: any
    componentBuilder: any
    studioChat: any
    studioCore: any
    billing: any
  }>()

  // Create component registry from domain (same pattern as AppShell)
  const prevBindingsKeyRef = useRef<string>('')
  const registryRef = useRef<ReturnType<typeof createRegistryFromDomain> | null>(null)

  const bindings = componentBuilder?.rendererBindingCollection?.all() ?? []
  const currentBindingsKey = bindings.map((b: any) =>
    `${b.id}:${b.updatedAt ?? ''}`
  ).join('|')

  if (currentBindingsKey !== prevBindingsKeyRef.current || !registryRef.current) {
    prevBindingsKeyRef.current = currentBindingsKey
    registryRef.current = createRegistryFromDomain(componentBuilder)
  }

  const registry = registryRef.current

  // Track current chat session in URL
  const { chatSessionId, setChatSessionId } = useChatSessionNavigation()

  // Chat panel state - now on LEFT side
  const [isChatCollapsed, setIsChatCollapsed] = useState(false)
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH)

  // Chat sessions panel state (toggled via history icon)
  const [showChatSessions, setShowChatSessions] = useState(false)

  // Preview controls state
  const [currentViewport, setCurrentViewport] = useState<ViewportSize>("desktop")
  const [currentRoute, setCurrentRoute] = useState("/")

  // Preview mode: 'runtime' (RuntimePreviewPanel), 'code' (CodeEditorPanel), or 'workspace' (ComposablePhaseView)
  const [previewMode, setPreviewMode] = useState<'runtime' | 'code' | 'workspace'>('runtime')

  // Project state
  // Use transition state if available (from homepage flow) to avoid loading flash
  const [project, setProject] = useState<any>(transitionState?.project ?? null)
  const [isLoading, setIsLoading] = useState(!transitionState?.project)

  // Transition overlay state - for animating from homepage to chat panel
  const chatInputContainerRef = useRef<HTMLDivElement>(null)
  const [transitionOverlayActive, setTransitionOverlayActive] = useState(false)
  const [transitionEndRect, setTransitionEndRect] = useState<DOMRect | null>(null)
  const transitionMeasuredRef = useRef(false)

  // Convert serialized start rect to DOMRect
  const transitionStartRect = transitionState?.transitionStartRect
    ? new DOMRect(
        transitionState.transitionStartRect.left,
        transitionState.transitionStartRect.top,
        transitionState.transitionStartRect.width,
        transitionState.transitionStartRect.height
      )
    : null

  // Clear location state after consuming initialMessage to prevent re-injection on refresh
  useEffect(() => {
    if (transitionState?.initialMessage) {
      // Replace current history entry without the state
      window.history.replaceState({}, document.title)
    }
  }, []) // Only run on mount

  // Measure ChatPanel input and activate transition overlay
  // This runs once when we have a start rect and the ChatPanel has mounted
  useEffect(() => {
    if (
      !transitionStartRect ||
      !chatInputContainerRef.current ||
      transitionMeasuredRef.current ||
      isChatCollapsed
    ) {
      return
    }

    // Wait for layout to settle
    const measureAndActivate = () => {
      const endRect = chatInputContainerRef.current?.getBoundingClientRect()
      if (endRect) {
        transitionMeasuredRef.current = true
        setTransitionEndRect(endRect)
        setTransitionOverlayActive(true)
      }
    }

    // Use requestAnimationFrame to ensure layout is complete
    requestAnimationFrame(() => {
      requestAnimationFrame(measureAndActivate)
    })
  }, [transitionStartRect, isChatCollapsed])

  // Handle transition overlay completion
  const handleTransitionComplete = useCallback(() => {
    setTransitionOverlayActive(false)
    setTransitionEndRect(null)
  }, [])

  // Check if domains are ready
  const domainsReady = !!studioCore?.projectCollection

  // Load project data with retry logic for schema loading race condition
  useEffect(() => {
    if (!projectId || !domainsReady) {
      return
    }

    let cancelled = false
    const MAX_RETRIES = 5
    const RETRY_DELAY_MS = 500

    const loadProjectData = async (attempt = 1): Promise<void> => {
      if (cancelled) return

      setIsLoading(true)
      try {
        // Load the project
        const proj = await studioCore.projectCollection.query()
          .where({ id: projectId })
          .first()

        if (cancelled) return

        if (proj) {
          setProject(proj)
          setIsLoading(false)
        } else {
          console.warn("[ProjectLayout] Project not found:", projectId)
          setIsLoading(false)
        }
      } catch (err: any) {
        if (cancelled) return

        // Retry if schema not loaded yet (race condition on page refresh)
        const isSchemaNotLoaded = err?.message?.includes("Schema") || err?.message?.includes("SCHEMA_NOT_FOUND")
        if (isSchemaNotLoaded && attempt < MAX_RETRIES) {
          console.debug(`[ProjectLayout] Schema not ready, retrying (${attempt}/${MAX_RETRIES})...`)
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt))
          return loadProjectData(attempt + 1)
        }

        console.error("[ProjectLayout] Failed to load project:", err)
        setIsLoading(false)
      }
    }

    loadProjectData()

    return () => {
      cancelled = true
    }
  }, [projectId, domainsReady, studioCore])

  // Get workspace composition for observability
  const workspaceComposition = componentBuilder?.compositionCollection?.findByName?.(
    WORKSPACE_COMPOSITION_NAME
  )

  // Get chat sessions for this project (synchronous - uses in-memory data)
  const projectChatSessions: ChatSessionItem[] = projectId
    ? (studioChat?.chatSessionCollection?.findByContext?.(projectId) ?? []).map((s: any) => ({
        id: s.id,
        name: s.name || s.inferredName,
        messageCount: s.messageCount ?? 0,
        updatedAt: s.lastActiveAt,
      }))
    : []

  // Auto-select last chat session or create one if none exists
  // This runs when the project loads and there's no session in the URL
  useEffect(() => {
    if (!projectId || !studioChat?.chatSessionCollection || chatSessionId) {
      // Already have a session selected, or not ready yet
      return
    }

    let cancelled = false
    const CHAT_MAX_RETRIES = 5
    const CHAT_RETRY_DELAY_MS = 500

    const initializeChatSession = async (attempt = 1): Promise<void> => {
      if (cancelled) return

      try {
        // Query database directly for existing sessions (in-memory may not be loaded yet)
        const existingSessions = await studioChat.chatSessionCollection
          .query({ contextId: projectId })
          .toArray()

        if (cancelled) return

        if (existingSessions.length > 0) {
          // Sort by lastActiveAt descending and select the most recent
          const sortedSessions = [...existingSessions].sort(
            (a: any, b: any) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0)
          )
          const mostRecent = sortedSessions[0]
          await setChatSessionId(mostRecent.id)
        } else {
          // No existing sessions - create a new one
          const newSession = await studioChat.createChatSession({
            inferredName: `Chat ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
            contextType: "project",
            contextId: projectId,
          })
          await setChatSessionId(newSession.id)
        }
      } catch (err: any) {
        if (cancelled) return

        // Retry if schema not loaded yet (race condition on page refresh)
        const isSchemaNotLoaded = err?.message?.includes("Schema") || err?.message?.includes("SCHEMA_NOT_FOUND")
        if (isSchemaNotLoaded && attempt < CHAT_MAX_RETRIES) {
          console.debug(`[ProjectLayout] Chat schema not ready, retrying (${attempt}/${CHAT_MAX_RETRIES})...`)
          await new Promise(resolve => setTimeout(resolve, CHAT_RETRY_DELAY_MS * attempt))
          return initializeChatSession(attempt + 1)
        }

        console.error("[ProjectLayout] Failed to initialize chat session:", err)
      }
    }

    initializeChatSession()

    return () => {
      cancelled = true
    }
  }, [projectId, studioChat, chatSessionId, setChatSessionId])

  // Keyboard shortcut: Cmd+Shift+A to toggle to advanced chat view
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "a") {
        e.preventDefault()
        // Preserve chatSessionId in URL when switching
        const params = chatSessionId ? `?chatSessionId=${chatSessionId}` : ""
        navigate(`/projects/${projectId}/advanced-chat${params}`)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [navigate, projectId, chatSessionId])

  // Session handlers
  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      await setChatSessionId(sessionId)
    },
    [setChatSessionId]
  )

  const handleCreateSession = useCallback(async () => {
    if (!studioChat || !projectId) return
    const newSession = await studioChat.createChatSession({
      inferredName: `Chat ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      contextType: "project",
      contextId: projectId,
    })
    await setChatSessionId(newSession.id)
  }, [studioChat, projectId, setChatSessionId])

  const handleChatSessionChange = useCallback(
    async (sessionId: string) => {
      await setChatSessionId(sessionId)
    },
    [setChatSessionId]
  )

  const handleRenameSession = useCallback(
    async (sessionId: string, newName: string) => {
      if (!studioChat?.chatSessionCollection) return
      await studioChat.chatSessionCollection.updateOne(sessionId, {
        name: newName,
      })
    },
    [studioChat]
  )

  // Project rename handler
  const handleRenameProject = useCallback(
    async (newName: string) => {
      if (!studioCore?.projectCollection || !projectId) return
      await studioCore.projectCollection.updateOne(projectId, {
        name: newName,
      })
      // Update local state
      setProject((prev: any) => prev ? { ...prev, name: newName } : prev)
    },
    [studioCore, projectId]
  )

  // Chat sessions toggle handler (triggered by history icon)
  const handleChatSessionsToggle = useCallback(() => {
    setShowChatSessions((prev) => !prev)
  }, [])

  // Chat collapse toggle handler
  const handleChatCollapseToggle = useCallback(() => {
    setIsChatCollapsed((prev) => !prev)
  }, [])

  // Preview controls handlers
  const handleViewportChange = useCallback((viewport: ViewportSize) => {
    setCurrentViewport(viewport)
    // TODO: Update preview iframe width based on viewport
  }, [])

  const handleRouteChange = useCallback((route: string) => {
    setCurrentRoute(route)
    // TODO: Navigate preview iframe to route
  }, [])

  const handleRefresh = useCallback(() => {
    // TODO: Refresh preview iframe
    console.log("Refresh preview")
  }, [])

  // Publish handlers
  const handlePublish = useCallback(
    async (data: {
      subdomain: string
      accessLevel: "anyone" | "authenticated" | "private"
      siteTitle?: string
      siteDescription?: string
    }) => {
      if (!projectId) throw new Error("No project ID")

      const response = await fetch(`/api/projects/${projectId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error?.message || "Failed to publish")
      }

      const result = await response.json()

      // Update local project state with publish info
      setProject((prev: any) =>
        prev
          ? {
              ...prev,
              publishedSubdomain: data.subdomain,
              publishedAt: result.publishedAt,
              accessLevel: data.accessLevel,
              siteTitle: data.siteTitle,
              siteDescription: data.siteDescription,
            }
          : prev
      )

      return result
    },
    [projectId]
  )

  const handleUnpublish = useCallback(async () => {
    if (!projectId) throw new Error("No project ID")

    const response = await fetch(`/api/projects/${projectId}/unpublish`, {
      method: "POST",
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error?.message || "Failed to unpublish")
    }

    // Clear publish info from local project state
    setProject((prev: any) =>
      prev
        ? {
            ...prev,
            publishedSubdomain: undefined,
            publishedAt: undefined,
            accessLevel: undefined,
            siteTitle: undefined,
            siteDescription: undefined,
          }
        : prev
    )
  }, [projectId])

  const handleUpdatePublishSettings = useCallback(
    async (data: {
      accessLevel?: "anyone" | "authenticated" | "private"
      siteTitle?: string
      siteDescription?: string
    }) => {
      if (!projectId) throw new Error("No project ID")

      const response = await fetch(`/api/projects/${projectId}/publish`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error?.message || "Failed to update settings")
      }

      // Update local project state
      setProject((prev: any) =>
        prev
          ? {
              ...prev,
              ...(data.accessLevel !== undefined && { accessLevel: data.accessLevel }),
              ...(data.siteTitle !== undefined && { siteTitle: data.siteTitle }),
              ...(data.siteDescription !== undefined && { siteDescription: data.siteDescription }),
            }
          : prev
      )
    },
    [projectId]
  )

  // Current user info from session
  const currentUserName = session?.user?.name?.split(" ")[0] || "You"
  const userInitial = session?.user?.name?.charAt(0).toUpperCase() || "U"

  // Get workspace ID for credit lookup
  const workspaceId = project
    ? (typeof project.workspace === 'string' ? project.workspace : project.workspace?.id)
    : null

  // Get credits from billing domain
  const creditLedger = workspaceId
    ? billing?.creditLedgerCollection?.findByWorkspace?.(workspaceId)
    : null
  const effectiveBalance = creditLedger?.effectiveBalance
  const creditsRemaining = effectiveBalance?.total ?? 5
  const maxCredits = effectiveBalance ? (effectiveBalance.dailyCredits + effectiveBalance.monthlyCredits + effectiveBalance.rolloverCredits) : 5

  // Loading state
  if (isLoading || !project) {
    return (
      <ComponentRegistryProvider registry={registry}>
        <div className="h-screen flex flex-col bg-background">
          <ProjectTopBar
            projectName="Loading..."
            projectId={projectId || ""}
            showChatSessions={showChatSessions}
            isChatCollapsed={isChatCollapsed}
            onChatSessionsToggle={handleChatSessionsToggle}
            onChatCollapseToggle={handleChatCollapseToggle}
          />
          <div className="flex-1 flex items-center justify-center">
            <div className="text-muted-foreground animate-pulse">Loading project...</div>
          </div>
        </div>
      </ComponentRegistryProvider>
    )
  }

  return (
    <ComponentRegistryProvider registry={registry}>
      <div className="h-screen flex flex-col bg-background">
        {/* Project top bar - Lovable.dev style */}
        <ProjectTopBar
          projectName={project.name}
          projectId={projectId || ""}
          credits={creditsRemaining}
          maxCredits={maxCredits}
          currentUserName={currentUserName}
          userInitial={userInitial}
          // Publish state props
          isPublished={!!project.publishedSubdomain}
          publishedAt={project.publishedAt ? new Date(project.publishedAt) : undefined}
          publishedSubdomain={project.publishedSubdomain}
          accessLevel={project.accessLevel}
          siteTitle={project.siteTitle}
          siteDescription={project.siteDescription}
          showChatSessions={showChatSessions}
          isChatCollapsed={isChatCollapsed}
          onChatSessionsToggle={handleChatSessionsToggle}
          onChatCollapseToggle={handleChatCollapseToggle}
          onRename={handleRenameProject}
          onViewportChange={handleViewportChange}
          onRouteChange={handleRouteChange}
          onRefresh={handleRefresh}
          // Publish callbacks
          onPublish={handlePublish}
          onUnpublish={handleUnpublish}
          onUpdatePublishSettings={handleUpdatePublishSettings}
        />

        {/* Main content: Chat/History panel (LEFT) + Preview/Workspace (RIGHT) */}
        <div className="flex-1 flex min-h-0">
          {/* Left Panel Container - Chat or History */}
          <div
            className={cn(
              "shrink-0 flex flex-col transition-all duration-200 bg-card",
              isChatCollapsed && "w-0 overflow-hidden"
            )}
            style={!isChatCollapsed ? { minWidth: `${chatWidth}px` } : undefined}
          >
            {!isChatCollapsed && (
              <>
                {showChatSessions ? (
                  // Chat Sessions Panel (triggered by history icon)
                  <ChatSessionsPanel
                    sessions={projectChatSessions}
                    currentSessionId={chatSessionId ?? undefined}
                    onSelect={(sessionId) => {
                      handleSelectSession(sessionId)
                      setShowChatSessions(false) // Close panel after selection
                    }}
                    onCreate={() => {
                      handleCreateSession()
                      setShowChatSessions(false) // Close panel after creation
                    }}
                    onRename={handleRenameSession}
                    className="flex-1"
                  />
                ) : (
                  // Chat Panel (no header)
                  // credit-tracking: Pass workspaceId and userId for credit deduction
                  // Handle both resolved MST reference (object with .id) and unresolved (string)
                  <ChatPanel
                    featureId={projectId}
                    featureName={project.name}
                    phase={null}
                    chatSessionId={chatSessionId}
                    onChatSessionChange={handleChatSessionChange}
                    isCollapsed={isChatCollapsed}
                    onCollapsedChange={setIsChatCollapsed}
                    onWidthChange={setChatWidth}
                    workspaceId={typeof project.workspace === 'string' ? project.workspace : project.workspace?.id}
                    userId={session?.user?.id}
                    projectId={projectId}
                    className="flex-1 min-h-0"
                    initialMessage={transitionState?.initialMessage}
                    inputContainerRef={chatInputContainerRef}
                  />
                )}
              </>
            )}
          </div>

          {/* Separator - subtle vertical line */}
          {!isChatCollapsed && (
            <div className="w-px bg-border/60" />
          )}

          {/* Preview/Workspace Container - with border styling */}
          <div className="flex-1 min-w-0 overflow-hidden p-3 bg-muted/30">
            {/* Preview Mode Toggle (subtle tabs) */}
            <div className="flex items-center gap-1 mb-2">
              <button
                onClick={() => setPreviewMode('runtime')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'runtime'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                Preview
              </button>
              <button
                onClick={() => setPreviewMode('code')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'code'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                Code
              </button>
              <button
                onClick={() => setPreviewMode('workspace')}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                  previewMode === 'workspace'
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                Workspace
              </button>
            </div>

            {/* Preview Frame with border - all panels stay mounted for state persistence */}
            <div className="h-[calc(100%-32px)] w-full rounded-lg border border-border/40 bg-background shadow-sm overflow-hidden relative">
              {/* Runtime Preview - stays mounted to preserve iframe state */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'runtime' && "invisible pointer-events-none"
              )}>
                <RuntimePreviewPanel
                  projectId={projectId || ''}
                  className="h-full"
                  onError={(err) => {
                    console.error('[ProjectLayout] Runtime error:', err)
                    // Could show toast here
                  }}
                  onLoad={() => {
                    console.log('[ProjectLayout] Runtime loaded successfully')
                  }}
                />
              </div>
              {/* Code Editor - stays mounted to preserve editor state */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'code' && "invisible pointer-events-none"
              )}>
                <CodeEditorPanel
                  projectId={projectId || ''}
                  className="h-full"
                />
              </div>
              {/* Workspace View - stays mounted for consistency */}
              <div className={cn(
                "absolute inset-0",
                previewMode !== 'workspace' && "invisible pointer-events-none"
              )}>
                <ComposablePhaseView
                  phaseName={WORKSPACE_COMPOSITION_NAME}
                  feature={project}
                  className="h-full"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Transition overlay - animates input from homepage to chat panel position */}
        {transitionStartRect && transitionEndRect && (
          <ChatPanelTransitionOverlay
            startRect={transitionStartRect}
            endRect={transitionEndRect}
            promptText={transitionState?.transitionPromptText ?? ""}
            onComplete={handleTransitionComplete}
            isActive={transitionOverlayActive}
            duration={400}
          />
        )}
      </div>
    </ComponentRegistryProvider>
  )
})
