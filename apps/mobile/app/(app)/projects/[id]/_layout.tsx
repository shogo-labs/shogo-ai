/**
 * ProjectLayout - Main project view layout (mobile)
 *
 * Responsive split-panel layout with chat + canvas:
 * - Wide screens (>= 1024px): side-by-side, chat panel on left (w-[480px]), canvas on right (flex-1)
 * - Narrow screens (< 1024px): tab interface to switch between chat and canvas
 *
 * Mobile-specific adaptations from web ProjectLayout:
 * - No desktop runtime, no iframe preview, no transition overlay
 * - Uses useWindowDimensions() instead of CSS media queries
 * - Tab bar on narrow screens instead of collapsible panel
 * - Dynamic app renderer for canvas (same shared-app hooks)
 * - AsyncStorage for chat session persistence instead of localStorage
 */

import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  useWindowDimensions,
  ScrollView,
} from 'react-native'
import { useLocalSearchParams, Stack } from 'expo-router'
import { observer } from 'mobx-react-lite'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  useSDKDomain,
  useSDKReady,
  useDomainActions,
  useProjectCollection,
} from '@shogo/shared-app/domain'
import {
  useDynamicAppStream,
  useAgentUrl,
} from '@shogo/shared-app/dynamic-app'
import type { IDomainStore } from '@shogo/domain-stores'
import { Platform } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../../../contexts/auth'
import { API_URL } from '../../../../lib/api'
import { ChatPanel } from '../../../../components/chat/ChatPanel'
import { DynamicAppRenderer } from '../../../../components/dynamic-app/DynamicAppRenderer'
import { ProjectTopBar } from '../../../../components/project/ProjectTopBar'
import {
  LogsPanel,
  StatusPanel,
  ChannelsPanel,
  SkillsPanel,
  MCPServersPanel,
  WorkspacePanel,
  AnalyticsPanel,
} from '../../../../components/project/panels'

type ActiveTab = 'chat' | 'canvas'

const WIDE_BREAKPOINT = 1024
const CHAT_PANEL_WIDTH = 480

export default observer(function ProjectLayout() {
  const params = useLocalSearchParams<{
    id: string
    chatSessionId?: string
    initialMessage?: string
  }>()
  const projectId = params.id
  const { width } = useWindowDimensions()
  const isWide = width >= WIDE_BREAKPOINT
  const { user } = useAuth()

  const store = useSDKDomain() as IDomainStore
  const { isReady: sdkReady } = useSDKReady()
  const actions = useDomainActions()
  const projects = useProjectCollection()

  // Capture initialMessage once so it doesn't re-fire on re-renders
  const [capturedInitialMessage] = useState(() => params.initialMessage ?? undefined)

  // Tab state for narrow screens
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat')

  // Chat session tracking — seed from route param if provided
  const [chatSessionId, setChatSessionId] = useState<string | null>(
    () => params.chatSessionId ?? null
  )

  // Project state
  const [project, setProject] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)

  const isAgentProject = project?.type === 'AGENT'

  // Dynamic app canvas (agent projects)
  const { agentUrl } = useAgentUrl(API_URL!, projectId, { credentials: Platform.OS === 'web' ? 'include' : 'omit' })
  const { surfaces, connected, dispatchAction, updateLocalData } = useDynamicAppStream(agentUrl)
  const activeSurface = surfaces.size > 0 ? Array.from(surfaces.values())[0] : null

  // Canvas action handler
  const handleCanvasAction = useCallback(
    (surfaceId: string, name: string, context?: Record<string, unknown>) => {
      dispatchAction(surfaceId, name, context)
    },
    [dispatchAction],
  )

  // Load project data
  const domainsReady = sdkReady && !!store?.projectCollection

  useEffect(() => {
    if (!projectId || !domainsReady || !user?.id) return

    let cancelled = false
    const MAX_RETRIES = 8
    const RETRY_DELAY_MS = 500

    const loadProject = async (attempt = 1): Promise<void> => {
      if (cancelled) return
      setIsLoading(true)

      try {
        await store.workspaceCollection.loadAll({ userId: user!.id })
        const proj = await store.projectCollection.loadById(projectId)

        if (cancelled) return

        if (proj) {
          setProject(proj)
          setIsLoading(false)
        } else if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
          return loadProject(attempt + 1)
        } else {
          console.warn('[ProjectLayout] Project not found after retries:', projectId)
          setIsLoading(false)
        }
      } catch (err: any) {
        if (cancelled) return
        const isTransient =
          err?.message?.includes('Schema') || err?.message?.includes('not found')
        if (isTransient && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
          return loadProject(attempt + 1)
        }
        console.error('[ProjectLayout] Failed to load project:', err)
        setIsLoading(false)
      }
    }

    loadProject()
    return () => {
      cancelled = true
    }
  }, [projectId, domainsReady, store, user?.id])

  // Persist last chat session to AsyncStorage
  useEffect(() => {
    if (projectId && chatSessionId) {
      AsyncStorage.setItem(`shogo:lastChatSession:${projectId}`, chatSessionId).catch(() => {})
    }
  }, [projectId, chatSessionId])

  // Auto-select or create chat session
  useEffect(() => {
    if (!projectId || !store?.chatSessionCollection || chatSessionId) return

    let cancelled = false

    const initSession = async () => {
      try {
        await store.chatSessionCollection.loadAll({ contextId: projectId })
        if (cancelled) return

        const existing = store.chatSessionCollection.all.filter(
          (s: any) => s.contextId === projectId,
        )

        if (existing.length > 0) {
          const lastId = await AsyncStorage.getItem(`shogo:lastChatSession:${projectId}`)
          const match = lastId ? existing.find((s: any) => s.id === lastId) : null
          const selected =
            match ??
            [...existing].sort((a: any, b: any) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
          if (selected && !cancelled) {
            setChatSessionId(selected.id)
          }
        } else {
          const newSession = await actions.createChatSession({
            inferredName: `Chat ${new Date().toLocaleDateString()}`,
            contextType: 'project',
            contextId: projectId,
          })
          if (newSession?.id && !cancelled) {
            setChatSessionId(newSession.id)
          }
        }
      } catch (err) {
        console.error('[ProjectLayout] Failed to initialize chat session:', err)
      }
    }

    initSession()
    return () => {
      cancelled = true
    }
  }, [projectId, store, chatSessionId, actions])

  const handleChatSessionChange = useCallback((sessionId: string) => {
    setChatSessionId(sessionId)
  }, [])

  // Chat panel visibility
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [showChatSessions, setShowChatSessions] = useState(false)
  const [previewTab, setPreviewTab] = useState('dynamic-app')

  // Loading state
  if (isLoading || !project) {
    return (
      <>
        <Stack.Screen options={{ headerShown: false }} />
        <View className="flex-1 bg-background items-center justify-center">
          <ActivityIndicator size="large" />
          <Text className="text-muted-foreground mt-3 text-sm">Loading project...</Text>
        </View>
      </>
    )
  }

  const chatPanel = (
    <ChatPanel
      featureId={projectId ?? null}
      featureName={project.name}
      phase={null}
      chatSessionId={chatSessionId}
      onChatSessionChange={handleChatSessionChange}
      workspaceId={project?.workspaceId}
      userId={user?.id}
      projectId={projectId}
      projectType={isAgentProject ? 'AGENT' : 'APP'}
      initialMessage={capturedInitialMessage}
      className="flex-1"
    />
  )

  const canvasPanel = (
    <CanvasPanel
      surface={activeSurface}
      connected={connected}
      agentUrl={agentUrl}
      onAction={handleCanvasAction}
      onDataChange={updateLocalData}
    />
  )

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      {isWide ? (
        <View className="flex-1 bg-background">
          <ProjectTopBar
            projectName={project.name}
            projectId={projectId!}
            showChatSessions={showChatSessions}
            isChatCollapsed={chatCollapsed}
            onChatSessionsToggle={() => setShowChatSessions((s) => !s)}
            onChatCollapseToggle={() => setChatCollapsed((c) => !c)}
            activeTab={previewTab}
            onTabChange={setPreviewTab}
          />
          <View className="flex-1 flex-row">
            {!chatCollapsed && (
              <View style={{ width: CHAT_PANEL_WIDTH }} className="border-r border-border">
                {chatPanel}
              </View>
            )}
            <View className="flex-1 relative">
              <View
                className="absolute inset-0"
                style={previewTab !== 'dynamic-app' ? { display: 'none' } : undefined}
              >
                {canvasPanel}
              </View>
              <StatusPanel visible={previewTab === 'status'} projectId={projectId!} agentUrl={agentUrl} />
              <WorkspacePanel visible={previewTab === 'workspace'} projectId={projectId!} agentUrl={agentUrl} />
              <SkillsPanel visible={previewTab === 'skills'} projectId={projectId!} agentUrl={agentUrl} />
              <MCPServersPanel visible={previewTab === 'mcp-servers'} projectId={projectId!} agentUrl={agentUrl} />
              <ChannelsPanel visible={previewTab === 'channels'} projectId={projectId!} agentUrl={agentUrl} />
              <AnalyticsPanel visible={previewTab === 'analytics'} projectId={projectId!} agentUrl={agentUrl} />
              <LogsPanel visible={previewTab === 'logs'} projectId={projectId!} agentUrl={agentUrl} />
            </View>
          </View>
        </View>
      ) : (
        <View className="flex-1 bg-background">
          <ProjectTopBar
            projectName={project.name}
            projectId={projectId!}
            activeTab={previewTab}
            onTabChange={(tabId) => {
              setPreviewTab(tabId)
              if (tabId !== 'dynamic-app') setActiveTab('canvas')
            }}
          />
          <View className="flex-row border-b border-border">
            {(['chat', 'canvas'] as ActiveTab[]).map((tab) => (
              <Pressable
                key={tab}
                onPress={() => {
                  setActiveTab(tab)
                  if (tab === 'canvas') setPreviewTab('dynamic-app')
                }}
                className={cn(
                  'flex-1 py-3 items-center',
                  activeTab === tab && 'border-b-2 border-primary',
                )}
              >
                <Text
                  className={cn(
                    'text-sm font-medium',
                    activeTab === tab ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  {tab === 'chat'
                    ? 'Chat'
                    : `Canvas${activeSurface ? ` (${activeSurface.title || 'Live'})` : ''}`}
                </Text>
              </Pressable>
            ))}
          </View>
          {activeTab === 'chat' ? (
            chatPanel
          ) : previewTab === 'dynamic-app' ? (
            canvasPanel
          ) : (
            <View className="flex-1 relative">
              <StatusPanel visible={previewTab === 'status'} projectId={projectId!} agentUrl={agentUrl} />
              <WorkspacePanel visible={previewTab === 'workspace'} projectId={projectId!} agentUrl={agentUrl} />
              <SkillsPanel visible={previewTab === 'skills'} projectId={projectId!} agentUrl={agentUrl} />
              <MCPServersPanel visible={previewTab === 'mcp-servers'} projectId={projectId!} agentUrl={agentUrl} />
              <ChannelsPanel visible={previewTab === 'channels'} projectId={projectId!} agentUrl={agentUrl} />
              <AnalyticsPanel visible={previewTab === 'analytics'} projectId={projectId!} agentUrl={agentUrl} />
              <LogsPanel visible={previewTab === 'logs'} projectId={projectId!} agentUrl={agentUrl} />
            </View>
          )}
        </View>
      )}
    </>
  )
})

// ---------------------------------------------------------------------------
// Canvas Panel — renders dynamic app surfaces or runtime preview placeholder
// ---------------------------------------------------------------------------

function CanvasPanel({
  surface,
  connected,
  agentUrl,
  onAction,
  onDataChange,
}: {
  surface: any | null
  connected: boolean
  agentUrl: string | null
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
  onDataChange?: (surfaceId: string, path: string, value: unknown) => void
}) {
  if (!agentUrl) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <ActivityIndicator size="large" className="mb-4" />
        <Text className="text-muted-foreground text-center">
          Connecting to agent runtime...
        </Text>
        <Text className="text-muted-foreground text-xs text-center mt-2">
          Send a message in the Chat tab to wake the agent
        </Text>
      </View>
    )
  }

  if (!surface) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <View
          className={cn(
            'w-3 h-3 rounded-full mb-3',
            connected ? 'bg-emerald-500' : 'bg-muted',
          )}
        />
        <Text className="text-foreground font-semibold mb-1">
          {connected ? 'Connected' : 'Waiting for connection...'}
        </Text>
        <Text className="text-muted-foreground text-center text-sm">
          {connected
            ? 'The canvas will appear once the agent creates a UI. Ask it to build something!'
            : 'Connecting to the agent runtime...'}
        </Text>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
      <DynamicAppRenderer
        surface={surface}
        agentUrl={agentUrl}
        onAction={onAction}
        onDataChange={onDataChange}
      />
    </ScrollView>
  )
}
