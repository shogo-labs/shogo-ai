/**
 * AdvancedChatLayout - Smart component for the Advanced Chat Testbed
 *
 * Uses ComposablePhaseView pattern with a "workspace" Composition entity.
 * Virtual tools (like show_schema) modify the Composition's slotContent,
 * and MobX reactivity triggers re-render via observer().
 *
 * Task: task-testbed-layout, req-wpp-layout-refactor
 * Feature: virtual-tools-domain
 *
 * Design Decisions:
 * - dd-wpp-composition-state: Workspace state lives in Composition entity (not React state)
 * - dd-testbed-session-strategy: Create synthetic 'testbed-session' FeatureSession on-demand
 * - dd-wpp-composable-pattern: Use ComposablePhaseView to render workspace Composition
 */

import { observer } from "mobx-react-lite"
import { useEffect, useState, useCallback } from "react"
import { useDomains } from "@/contexts/DomainProvider"
import { ComposablePhaseView } from "../../rendering/composition/ComposablePhaseView"
import { ChatPanel } from "../chat/ChatPanel"
import { ChatSessionPicker, type ChatSession } from "../chat/ChatSessionPicker"

// ============================================================
// Constants
// ============================================================

const TESTBED_SESSION_ID = "testbed-session"
const WORKSPACE_COMPOSITION_NAME = "workspace"

// ============================================================
// Component
// ============================================================

export const AdvancedChatLayout = observer(function AdvancedChatLayout() {
  const { platformFeatures, componentBuilder, studioChat } = useDomains<{
    platformFeatures: any
    componentBuilder: any
    studioChat: any
  }>()

  // Track current chat session (for session picker)
  const [currentChatSessionId, setCurrentChatSessionId] = useState<string | null>(null)

  // Get or create testbed session
  const testbedSession = platformFeatures?.featureSessionCollection?.get(TESTBED_SESSION_ID)

  // Ensure testbed session exists (for ChatPanel and DesignContainerSection)
  useEffect(() => {
    if (!platformFeatures?.featureSessionCollection) return

    const existing = platformFeatures.featureSessionCollection.get(TESTBED_SESSION_ID)
    if (!existing) {
      platformFeatures.featureSessionCollection.insertOne({
        id: TESTBED_SESSION_ID,
        name: "Advanced Chat Testbed",
        intent: "Virtual tools development testbed",
        status: "discovery",
        createdAt: Date.now(),
      })
    }
  }, [platformFeatures])

  // Get workspace composition (for observability - triggers re-render when modified)
  const workspaceComposition = componentBuilder?.compositionCollection?.findByName?.(WORKSPACE_COMPOSITION_NAME)

  // Get all chat sessions for the testbed feature
  const testbedChatSessions: ChatSession[] = (
    studioChat?.chatSessionCollection?.findByFeature?.(TESTBED_SESSION_ID) ?? []
  ).map((s: any) => ({
    id: s.id,
    name: s.name || s.inferredName,
    messageCount: s.messageCount ?? 0,
    updatedAt: s.lastActiveAt,
  }))

  // Handler for session selection
  const handleSelectSession = useCallback((sessionId: string) => {
    setCurrentChatSessionId(sessionId)
  }, [])

  // Handler for creating a new session
  const handleCreateSession = useCallback(async () => {
    if (!studioChat) return
    const newSession = await studioChat.createChatSession({
      inferredName: `Chat ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      contextType: "feature",
      contextId: TESTBED_SESSION_ID,
    })
    setCurrentChatSessionId(newSession.id)
  }, [studioChat])

  // Sync from ChatPanel when it auto-creates a session
  const handleChatSessionChange = useCallback((sessionId: string) => {
    setCurrentChatSessionId(sessionId)
  }, [])

  // Handler for renaming a session
  const handleRenameSession = useCallback(async (sessionId: string, newName: string) => {
    if (!studioChat?.chatSessionCollection) return
    await studioChat.chatSessionCollection.updateOne(sessionId, { name: newName })
  }, [studioChat])

  // Wait for session to be created before rendering ChatPanel
  // This avoids race condition where ChatPanel tries to load messages before session exists
  if (!testbedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading workspace...</div>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Dynamic Workspace - ComposablePhaseView renders the workspace Composition */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <ComposablePhaseView
          phaseName={WORKSPACE_COMPOSITION_NAME}
          feature={testbedSession}
          className="h-full"
        />
      </div>

      {/* Chat Panel - fixed width on right */}
      <div className="w-[400px] border-l flex-shrink-0 flex flex-col">
        {/* Session Picker Header */}
        <div className="px-3 py-2 border-b flex items-center justify-between bg-muted/30">
          <span className="text-sm font-medium text-muted-foreground">Chat Sessions</span>
          <ChatSessionPicker
            sessions={testbedChatSessions}
            currentSessionId={currentChatSessionId ?? undefined}
            onSelect={handleSelectSession}
            onCreate={handleCreateSession}
            onRename={handleRenameSession}
          />
        </div>

        {/* Chat Panel */}
        <div className="flex-1 min-h-0">
          <ChatPanel
            featureId={TESTBED_SESSION_ID}
            featureName="Advanced Chat Testbed"
            phase={null}
            chatSessionId={currentChatSessionId}
            onChatSessionChange={handleChatSessionChange}
          />
        </div>
      </div>
    </div>
  )
})
