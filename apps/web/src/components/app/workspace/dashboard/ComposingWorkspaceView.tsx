/**
 * ComposingWorkspaceView - Split layout component for composing mode
 *
 * Mirrors AdvancedChatLayout structure after the HomePage transition animation.
 * Renders a split panel with:
 * - Left: ComposablePhaseView with "workspace" composition
 * - Right: ChatPanel with session management
 *
 * Applies animation classes based on transition phase.
 */

import { useState, useCallback, useEffect } from "react"
import { observer } from "mobx-react-lite"
import { useDomains } from "@/contexts/DomainProvider"
import { ComposablePhaseView } from "@/components/rendering/composition/ComposablePhaseView"
import { ChatPanel } from "../../chat/ChatPanel"
import {
  ChatSessionPicker,
  type ChatSession,
} from "../../chat/ChatSessionPicker"
import { cn } from "@/lib/utils"
import type { TransitionPhase } from "./HomePage"

const WORKSPACE_COMPOSITION_NAME = "workspace"

export interface ComposingWorkspaceViewProps {
  /** The feature session to associate with the workspace */
  featureSession: any
  /** The initial message to send to chat (the prompt that triggered the transition) */
  initialMessage: string | null
  /** Current transition phase for animation */
  transitionPhase: TransitionPhase
  /** Callback when a chat session is created or selected */
  onChatSessionChange?: (sessionId: string) => void
}

/**
 * ComposingWorkspaceView component
 *
 * Split layout that mirrors AdvancedChatLayout, used after the HomePage
 * transition animation. Shows workspace composition on the left and
 * chat panel on the right.
 */
export const ComposingWorkspaceView = observer(function ComposingWorkspaceView({
  featureSession,
  initialMessage,
  transitionPhase,
  onChatSessionChange,
}: ComposingWorkspaceViewProps) {
  const { studioChat } = useDomains<{ studioChat: any }>()

  // Chat panel state - lifted to parent for layout control
  const [chatWidth, setChatWidth] = useState(400)
  const [isChatCollapsed, setIsChatCollapsed] = useState(false)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)

  // Determine which elements to show based on transition phase
  const showWorkspace = ["emerge", "settle", "complete"].includes(transitionPhase)
  const showChatHeader = ["settle", "complete"].includes(transitionPhase)
  const isAnimating = transitionPhase !== "complete"

  // Get chat sessions for this feature
  const featureId = featureSession?.id
  const chatSessions: ChatSession[] = (
    studioChat?.chatSessionCollection?.findByFeature?.(featureId) ?? []
  ).map((s: any) => ({
    id: s.id,
    name: s.name || s.inferredName || "New Chat",
    messageCount: s.messageCount ?? 0,
    updatedAt: s.lastActiveAt ?? Date.now(),
  }))

  // Handler for session selection
  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      setChatSessionId(sessionId)
      onChatSessionChange?.(sessionId)
    },
    [onChatSessionChange]
  )

  // Handler for creating a new session
  const handleCreateSession = useCallback(async () => {
    if (!studioChat || !featureId) return
    const newSession = await studioChat.createChatSession({
      inferredName: `Chat ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      contextType: "feature",
      contextId: featureId,
    })
    setChatSessionId(newSession.id)
    onChatSessionChange?.(newSession.id)
  }, [studioChat, featureId, onChatSessionChange])

  // Sync from ChatPanel when it auto-creates a session
  const handleChatSessionChange = useCallback(
    async (sessionId: string) => {
      setChatSessionId(sessionId)
      onChatSessionChange?.(sessionId)
    },
    [onChatSessionChange]
  )

  // Handler for renaming a session
  const handleRenameSession = useCallback(
    async (sessionId: string, newName: string) => {
      if (!studioChat?.chatSessionCollection) return
      await studioChat.chatSessionCollection.updateOne(sessionId, {
        name: newName,
      })
    },
    [studioChat]
  )

  // Loading state while waiting for feature session
  if (!featureSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Setting up workspace...</div>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Workspace Panel - mirrors AdvancedChatLayout left side */}
      <div
        className={cn(
          "flex-1 min-w-0 overflow-hidden",
          showWorkspace && "animate-workspace-emerge"
        )}
        style={{ opacity: showWorkspace ? undefined : 0 }}
      >
        <ComposablePhaseView
          phaseName={WORKSPACE_COMPOSITION_NAME}
          feature={featureSession}
          className="h-full"
        />
      </div>

      {/* Chat Panel Container - mirrors AdvancedChatLayout right side */}
      <div
        className={cn(
          "flex-shrink-0 flex flex-col transition-all duration-200",
          showWorkspace && "border-l animate-border-fade",
          isChatCollapsed && "w-16"
        )}
        style={!isChatCollapsed ? { width: `${chatWidth}px` } : undefined}
      >
        {/* Session Picker Header - hide when collapsed or during early animation */}
        {!isChatCollapsed && showChatHeader && (
          <div
            className={cn(
              "px-3 py-2 border-b flex items-center justify-between bg-muted/30",
              isAnimating && "animate-header-settle"
            )}
          >
            <span className="text-sm font-medium text-muted-foreground">
              Chat Sessions
            </span>
            <ChatSessionPicker
              sessions={chatSessions}
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
            featureName={featureSession.name}
            phase="discovery"
            chatSessionId={chatSessionId}
            onChatSessionChange={handleChatSessionChange}
            isCollapsed={isChatCollapsed}
            onCollapsedChange={setIsChatCollapsed}
            onWidthChange={setChatWidth}
          />
        </div>
      </div>
    </div>
  )
})

export default ComposingWorkspaceView
