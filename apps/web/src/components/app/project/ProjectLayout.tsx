/**
 * ProjectLayout - Main project view layout
 *
 * Full-screen project editing experience similar to Lovable.dev:
 * - No sidebar navigation
 * - Minimal top bar with project name and actions
 * - Split view: Dynamic workspace (left) + Chat panel (right)
 *
 * Uses the same ComposablePhaseView pattern as AdvancedChatLayout
 * but scoped to a specific project.
 */

import { observer } from "mobx-react-lite"
import { useEffect, useCallback, useState, useRef } from "react"
import { useParams } from "react-router-dom"
import { useDomains } from "@/contexts/DomainProvider"
import { ComposablePhaseView } from "@/components/rendering/composition/ComposablePhaseView"
import { ComponentRegistryProvider } from "@/components/rendering"
import { createRegistryFromDomain } from "@/components/rendering/registryFactory"
import { ChatPanel } from "../chat/ChatPanel"
import {
  ChatSessionPicker,
  type ChatSession,
} from "../chat/ChatSessionPicker"
import { useChatSessionNavigation } from "../advanced-chat/hooks/useChatSessionNavigation"
import { ProjectTopBar } from "./ProjectTopBar"
import { cn } from "@/lib/utils"

const WORKSPACE_COMPOSITION_NAME = "workspace"

export const ProjectLayout = observer(function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>()

  const { platformFeatures, componentBuilder, studioChat, studioCore } = useDomains<{
    platformFeatures: any
    componentBuilder: any
    studioChat: any
    studioCore: any
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

  // Chat panel state
  const [isChatCollapsed, setIsChatCollapsed] = useState(false)
  const [chatWidth, setChatWidth] = useState(400)

  // Project and feature session state
  const [project, setProject] = useState<any>(null)
  const [featureSession, setFeatureSession] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Load project and create/load feature session
  useEffect(() => {
    if (!projectId || !studioCore?.projectCollection || !platformFeatures?.featureSessionCollection) {
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
        }
      } catch (err) {
        console.error("[ProjectLayout] Failed to load project:", err)
      } finally {
        setIsLoading(false)
      }
    }

    loadProjectData()
  }, [projectId, studioCore, platformFeatures])

  // Get workspace composition for observability
  const workspaceComposition = componentBuilder?.compositionCollection?.findByName?.(
    WORKSPACE_COMPOSITION_NAME
  )

  // Get chat sessions for this project's feature
  const featureId = featureSession?.id
  const projectChatSessions: ChatSession[] = featureId
    ? (studioChat?.chatSessionCollection?.findByFeature?.(featureId) ?? []).map((s: any) => ({
        id: s.id,
        name: s.name || s.inferredName,
        messageCount: s.messageCount ?? 0,
        updatedAt: s.lastActiveAt,
      }))
    : []

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

  // Loading state
  if (isLoading || !project || !featureSession) {
    return (
      <ComponentRegistryProvider registry={registry}>
        <div className="h-screen flex flex-col">
          <ProjectTopBar
            projectName="Loading..."
            projectId={projectId || ""}
          />
          <div className="flex-1 flex items-center justify-center">
            <div className="text-muted-foreground">Loading project...</div>
          </div>
        </div>
      </ComponentRegistryProvider>
    )
  }

  return (
    <ComponentRegistryProvider registry={registry}>
      <div className="h-screen flex flex-col">
        {/* Project top bar */}
        <ProjectTopBar
          projectName={project.name}
          projectId={projectId || ""}
        />

        {/* Main content: Dynamic workspace + Chat panel */}
        <div className="flex-1 flex min-h-0">
          {/* Dynamic Workspace */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <ComposablePhaseView
              phaseName={WORKSPACE_COMPOSITION_NAME}
              feature={featureSession}
              className="h-full"
            />
          </div>

          {/* Chat Panel Container */}
          <div
            className={cn(
              "border-l flex-shrink-0 flex flex-col transition-all duration-200",
              isChatCollapsed && "w-16"
            )}
            style={!isChatCollapsed ? { width: `${chatWidth}px` } : undefined}
          >
            {/* Session Picker Header */}
            {!isChatCollapsed && (
              <div className="px-3 py-2 border-b flex items-center justify-between bg-muted/30">
                <span className="text-sm font-medium text-muted-foreground">
                  Chat Sessions
                </span>
                <ChatSessionPicker
                  sessions={projectChatSessions}
                  currentSessionId={chatSessionId ?? undefined}
                  onSelect={handleSelectSession}
                  onCreate={handleCreateSession}
                  onRename={handleRenameSession}
                />
              </div>
            )}

            {/* Chat Panel */}
            <div className="flex-1 min-h-0">
              <ChatPanel
                featureId={featureId}
                featureName={project.name}
                phase={null}
                chatSessionId={chatSessionId}
                onChatSessionChange={handleChatSessionChange}
                isCollapsed={isChatCollapsed}
                onCollapsedChange={setIsChatCollapsed}
                onWidthChange={setChatWidth}
              />
            </div>
          </div>
        </div>
      </div>
    </ComponentRegistryProvider>
  )
})
