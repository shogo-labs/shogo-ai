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
import { useParams } from "react-router-dom"
import { useDomains } from "@/contexts/DomainProvider"
import { ComposablePhaseView } from "@/components/rendering/composition/ComposablePhaseView"
import { ComponentRegistryProvider } from "@/components/rendering"
import { createRegistryFromDomain } from "@/components/rendering/registryFactory"
import { ChatPanel } from "../chat/ChatPanel"
import { useChatSessionNavigation } from "../advanced-chat/hooks/useChatSessionNavigation"
import { ProjectTopBar } from "./ProjectTopBar"
import { ChatSessionsPanel, type ChatSessionItem } from "./ChatSessionsPanel"
import { cn } from "@/lib/utils"
import { useSession } from "@/auth/client"
import type { ViewportSize } from "./PreviewControls"

const WORKSPACE_COMPOSITION_NAME = "workspace"

// Default chat panel width in px
const DEFAULT_CHAT_WIDTH = 480

export const ProjectLayout = observer(function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>()
  const { data: session } = useSession()

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

  // Project and feature session state
  const [project, setProject] = useState<any>(null)
  const [featureSession, setFeatureSession] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Check if domains are ready
  const domainsReady = !!(studioCore?.projectCollection && platformFeatures?.featureSessionCollection)

  // Load project and create/load feature session
  useEffect(() => {
    if (!projectId || !domainsReady) {
      return
    }

    const loadProjectData = async () => {
      setIsLoading(true)
      try {
        // Load the project
        const proj = await studioCore.projectCollection.query()
          .where({ id: projectId })
          .first()

        if (proj) {
          setProject(proj)

          // Create or get the feature session for this project
          const sessionId = `project-${projectId}`
          let session = await platformFeatures.featureSessionCollection.query()
            .where({ id: sessionId })
            .first()

          if (!session) {
            session = await platformFeatures.featureSessionCollection.insertOne({
              id: sessionId,
              name: proj.name,
              intent: `Project workspace for ${proj.name}`,
              status: "discovery",
              createdAt: Date.now(),
            })
          }
          setFeatureSession(session)
        } else {
          console.warn("[ProjectLayout] Project not found:", projectId)
        }
      } catch (err) {
        console.error("[ProjectLayout] Failed to load project:", err)
      } finally {
        setIsLoading(false)
      }
    }

    loadProjectData()
  }, [projectId, domainsReady, studioCore, platformFeatures])

  // Get workspace composition for observability
  const workspaceComposition = componentBuilder?.compositionCollection?.findByName?.(
    WORKSPACE_COMPOSITION_NAME
  )

  // Get feature ID for chat
  const featureId = featureSession?.id

  // Get chat sessions for this project's feature
  const projectChatSessions: ChatSessionItem[] = featureId
    ? (studioChat?.chatSessionCollection?.findByFeature?.(featureId) ?? []).map((s: any) => ({
        id: s.id,
        name: s.name || s.inferredName,
        messageCount: s.messageCount ?? 0,
        updatedAt: s.lastActiveAt,
      }))
    : []

  // Auto-select last chat session or create one if none exists
  // This runs when the project loads and there's no session in the URL
  useEffect(() => {
    if (!featureId || !studioChat?.chatSessionCollection || chatSessionId) {
      // Already have a session selected, or not ready yet
      return
    }

    const initializeChatSession = async () => {
      // Query database directly for existing sessions (in-memory may not be loaded yet)
      const existingSessions = await studioChat.chatSessionCollection
        .query({ contextId: featureId })
        .toArray()

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
          contextType: "feature",
          contextId: featureId,
        })
        await setChatSessionId(newSession.id)
      }
    }

    initializeChatSession()
  }, [featureId, studioChat, chatSessionId, setChatSessionId])

  // Session handlers
  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      await setChatSessionId(sessionId)
    },
    [setChatSessionId]
  )

  const handleCreateSession = useCallback(async () => {
    if (!studioChat || !featureId) return
    const newSession = await studioChat.createChatSession({
      inferredName: `Chat ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      contextType: "feature",
      contextId: featureId,
    })
    await setChatSessionId(newSession.id)
  }, [studioChat, featureId, setChatSessionId])

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
  if (isLoading || !project || !featureSession) {
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
          showChatSessions={showChatSessions}
          isChatCollapsed={isChatCollapsed}
          onChatSessionsToggle={handleChatSessionsToggle}
          onChatCollapseToggle={handleChatCollapseToggle}
          onRename={handleRenameProject}
          onViewportChange={handleViewportChange}
          onRouteChange={handleRouteChange}
          onRefresh={handleRefresh}
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
                    featureId={featureId}
                    featureName={project.name}
                    phase={null}
                    chatSessionId={chatSessionId}
                    onChatSessionChange={handleChatSessionChange}
                    isCollapsed={isChatCollapsed}
                    onCollapsedChange={setIsChatCollapsed}
                    onWidthChange={setChatWidth}
                    workspaceId={typeof project.workspace === 'string' ? project.workspace : project.workspace?.id}
                    userId={session?.user?.id}
                    className="flex-1 min-h-0"
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
            {/* Preview Frame with border */}
            <div className="h-full w-full rounded-lg border border-border/40 bg-background shadow-sm overflow-hidden">
              <ComposablePhaseView
                phaseName={WORKSPACE_COMPOSITION_NAME}
                feature={featureSession}
                className="h-full"
              />
            </div>
          </div>
        </div>
      </div>
    </ComponentRegistryProvider>
  )
})
