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

import { useState, useEffect, useCallback, useMemo } from 'react'
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
import { cn } from '@shogo/shared-ui/primitives'
import { useBillingData } from '@shogo/shared-app/hooks'
import { useAuth } from '../../../../contexts/auth'
import { API_URL } from '../../../../lib/api'
import { consumePendingImageData } from '../../../../lib/pending-image-store'
import { ChatPanel } from '../../../../components/chat/ChatPanel'
import { ChatSessionPicker, type ChatSession } from '../../../../components/chat/ChatSessionPicker'
import { DynamicAppRenderer } from '../../../../components/dynamic-app/DynamicAppRenderer'
import { EditModeProvider, useEditModeOptional } from '../../../../components/dynamic-app/edit/EditModeContext'
import { EditToolbar } from '../../../../components/dynamic-app/edit/EditToolbar'
import { InspectorPanel } from '../../../../components/dynamic-app/edit/InspectorPanel'
import { ComponentTreePanel } from '../../../../components/dynamic-app/edit/ComponentTreePanel'
import { CanvasThemeProvider, CanvasThemedContainer } from '../../../../components/dynamic-app/CanvasThemeContext'
import { CanvasThemePicker } from '../../../../components/dynamic-app/CanvasThemePicker'
import { ProjectTopBar } from '../../../../components/project/ProjectTopBar'
import {
  LogsPanel,
  StatusPanel,
  ChannelsPanel,
  SkillsPanel,
  MCPServersPanel,
  WorkspacePanel,
  FilesBrowserPanel,
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

  // Capture initialMessage and imageData once so they don't re-fire on re-renders
  const [capturedInitialMessage] = useState(() => params.initialMessage ?? undefined)
  const [capturedInitialImageData] = useState(() => consumePendingImageData())

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

  const billingData = useBillingData(project?.workspaceId)

  const allProjects = useMemo(() => {
    try {
      const items = projects?.all ?? []
      return items.map((p: any) => ({
        id: p.id,
        name: p.name || 'Untitled',
        type: p.type || 'APP',
      }))
    } catch {
      return []
    }
  }, [projects?.all])

  // Dynamic app canvas (agent projects)
  const { agentUrl } = useAgentUrl(API_URL!, projectId, { credentials: 'include' })
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
        store.projectCollection.loadAll().catch(() => {})
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

  const [sessionNames, setSessionNames] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!showChatSessions || !store?.chatSessionCollection || !store?.chatMessageCollection) return

    const sessions = store.chatSessionCollection.all.filter((s: any) => s.contextId === projectId)

    const loadNames = async () => {
      const names: Record<string, string> = {}
      await Promise.all(
        sessions.map(async (s: any) => {
          const sessionName = s.name || s.inferredName || ''
          const isGenericName = !sessionName || sessionName.startsWith('Chat ') || sessionName.startsWith('Chat -')

          if (!isGenericName) {
            names[s.id] = sessionName
            return
          }

          try {
            await store.chatMessageCollection.loadAll({ sessionId: s.id })
            const msgs = store.chatMessageCollection.all
              .filter((m: any) => m.sessionId === s.id && m.role === 'user')
              .sort((a: any, b: any) => (a.createdAt || 0) - (b.createdAt || 0))
            const preview = msgs[0]?.content?.trim()
            names[s.id] = preview
              ? (preview.length > 40 ? preview.slice(0, 40) + '…' : preview)
              : `Chat · ${new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
          } catch {
            names[s.id] = `Chat · ${new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
          }
        })
      )
      setSessionNames(names)
    }

    loadNames()
  }, [showChatSessions, store, projectId])

  const chatSessions: ChatSession[] = useMemo(() => {
    if (!store?.chatSessionCollection) return []
    try {
      return store.chatSessionCollection.all
        .filter((s: any) => s.contextId === projectId)
        .map((s: any) => ({
          id: s.id,
          name: sessionNames[s.id] || s.name || s.inferredName || `Chat · ${new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
          messageCount: -1,
          updatedAt: s.lastActiveAt || s.updatedAt || s.createdAt || Date.now(),
        }))
        .sort((a: ChatSession, b: ChatSession) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }, [store?.chatSessionCollection?.all, sessionNames, projectId])

  const handleCreateNewSession = useCallback(async () => {
    try {
      const newSession = await actions.createChatSession({
        inferredName: `Chat ${new Date().toLocaleDateString()}`,
        contextType: 'project',
        contextId: projectId!,
      })
      if (newSession?.id) {
        setChatSessionId(newSession.id)
      }
    } catch (err) {
      console.error('[ProjectLayout] Failed to create chat session:', err)
    }
  }, [actions, projectId])

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
      initialImageData={capturedInitialImageData}
      billingData={billingData}
      className="flex-1"
    />
  )

  const canvasPanel = (
    <CanvasThemeProvider>
      <EditModeProvider agentUrl={agentUrl}>
        <CanvasPanel
          surface={activeSurface}
          connected={connected}
          agentUrl={agentUrl}
          onAction={handleCanvasAction}
          onDataChange={updateLocalData}
        />
      </EditModeProvider>
    </CanvasThemeProvider>
  )

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />

      {isWide ? (
        <View className="flex-1 bg-background">
          <ProjectTopBar
            projectName={project.name}
            projectId={projectId!}
            projectType={project.type}
            projects={allProjects}
            showChatSessions={showChatSessions}
            isChatCollapsed={chatCollapsed}
            onChatSessionsToggle={() => setShowChatSessions((s) => !s)}
            onChatCollapseToggle={() => setChatCollapsed((c) => !c)}
            activeTab={previewTab}
            onTabChange={setPreviewTab}
            hasActiveSubscription={billingData.hasActiveSubscription}
          />
          <View className="flex-1 flex-row">
            {!chatCollapsed && (
              <View style={{ width: CHAT_PANEL_WIDTH }} className="border-r border-border">
                {showChatSessions && (
                  <View className="border-b border-border">
                    <ChatSessionPicker
                      sessions={chatSessions}
                      currentSessionId={chatSessionId ?? undefined}
                      onSelect={(sessionId) => {
                        setChatSessionId(sessionId)
                        setShowChatSessions(false)
                      }}
                      onCreate={handleCreateNewSession}
                    />
                  </View>
                )}
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
              <FilesBrowserPanel visible={previewTab === 'files'} projectId={projectId!} agentUrl={agentUrl} />
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
            projectType={project.type}
            projects={allProjects}
            activeTab={previewTab}
            hasActiveSubscription={billingData.hasActiveSubscription}
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
              <FilesBrowserPanel visible={previewTab === 'files'} projectId={projectId!} agentUrl={agentUrl} />
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
  const editMode = useEditModeOptional()
  const isEditMode = editMode?.isEditMode ?? false
  const showTreePanel = editMode?.showTreePanel ?? false
  const surfaceId = surface?.surfaceId ?? null

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

  const themePicker = <CanvasThemePicker />

  if (!surface) {
    return (
      <View className="flex-1">
        <EditToolbar surfaceId={null} trailing={themePicker} />
        <View className="flex-1 p-3">
          <CanvasThemedContainer>
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
          </CanvasThemedContainer>
        </View>
      </View>
    )
  }

  return (
    <View className="flex-1">
      <EditToolbar surfaceId={surfaceId} components={surface.components} trailing={themePicker} />
      <View className="flex-1 flex-row">
        {isEditMode && showTreePanel && (
          <ComponentTreePanel surfaceId={surfaceId} components={surface.components} />
        )}
        <View className="flex-1 p-3">
          <CanvasThemedContainer>
            <ScrollView className="flex-1" contentContainerStyle={{ padding: 16 }}>
              <DynamicAppRenderer
                surface={surface}
                agentUrl={agentUrl}
                onAction={onAction}
                onDataChange={onDataChange}
              />
            </ScrollView>
          </CanvasThemedContainer>
        </View>
        {isEditMode && (
          <InspectorPanel surfaceId={surfaceId} components={surface.components} />
        )}
      </View>
    </View>
  )
}
