// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  useWindowDimensions,
  ScrollView,
  Platform,
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
import { getTotalCreditsForPlan } from '../../../../lib/billing-config'
import { useAuth } from '../../../../contexts/auth'
import { authClient } from '../../../../lib/auth-client'
import { API_URL, api } from '../../../../lib/api'
import { usePlatformConfig } from '../../../../lib/platform-config'
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
  ChannelsPanel,
  FilesBrowserPanel,
  CapabilitiesPanel,
  MonitorPanel,
} from '../../../../components/project/panels'
import { RefreshCw, MoreHorizontal } from 'lucide-react-native'
import {
  Popover,
  PopoverBackdrop,
  PopoverBody,
  PopoverContent,
} from '../../../../components/ui/popover'

type ActiveTab = 'chat' | 'canvas'

const WIDE_BREAKPOINT = 1024

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
  const [showMoreMenu, setShowMoreMenu] = useState(false)

  // Chat session tracking — seed from route param if provided
  const [chatSessionId, setChatSessionId] = useState<string | null>(
    () => params.chatSessionId ?? null
  )

  // Project state
  const [project, setProject] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)

  const isAgentProject = project?.type === 'AGENT'

  const { features } = usePlatformConfig()
  const billingData = useBillingData(features.billing ? project?.workspaceId : undefined)

  const effectiveHasActiveSubscription = features.billing
    ? billingData.hasActiveSubscription
    : true

  const workspaceName = useMemo(() => {
    try {
      const ws = store?.workspaceCollection?.all?.find(
        (w: any) => w.id === project?.workspaceId,
      )
      return ws?.name || ''
    } catch {
      return ''
    }
  }, [store?.workspaceCollection?.all, project?.workspaceId])

  const planLabel = billingData.subscription
    ? billingData.subscription.planId.charAt(0).toUpperCase() +
      billingData.subscription.planId.slice(1)
    : 'Free'

  const creditsTotal = getTotalCreditsForPlan(billingData.subscription?.planId)
  const creditsRemaining = billingData.effectiveBalance?.total ?? creditsTotal

  const isStarred = useMemo(() => {
    try {
      return store?.starredProjectCollection?.all?.some(
        (s: any) => s.projectId === projectId && s.userId === user?.id,
      ) ?? false
    } catch {
      return false
    }
  }, [store?.starredProjectCollection?.all, projectId, user?.id])

  const folders = useMemo(() => {
    try {
      return (store?.folderCollection?.all ?? []).map((f: any) => ({
        id: f.id,
        name: f.name || 'Untitled',
      }))
    } catch {
      return []
    }
  }, [store?.folderCollection?.all])

  const handleRenameProject = useCallback(async (newName: string) => {
    if (!projectId) return
    await actions.updateProject(projectId, { name: newName })
    setProject((prev: any) => prev ? { ...prev, name: newName } : prev)
  }, [projectId, actions])

  const handleToggleStar = useCallback(async () => {
    if (!projectId || !user?.id) return
    await actions.toggleStarProject(projectId, user.id, project?.workspaceId)
  }, [projectId, user?.id, project?.workspaceId, actions])

  const handleMoveToFolder = useCallback(async (folderId: string | null) => {
    if (!projectId) return
    await actions.moveProjectToFolder(projectId, folderId)
  }, [projectId, actions])

  const projectSettings = useMemo<Record<string, unknown>>(() => {
    if (typeof project?.settings === 'string') {
      try { return JSON.parse(project.settings) } catch { return {} }
    }
    if (project?.settings && typeof project.settings === 'object') {
      return project.settings as Record<string, unknown>
    }
    return {}
  }, [project?.settings])

  const canvasEnabled = projectSettings.canvasEnabled !== false

  const updateProjectSettings = useCallback(async (patch: Record<string, unknown>) => {
    if (!projectId) return
    const merged = { ...projectSettings, ...patch }
    const settingsStr = JSON.stringify(merged)
    await actions.updateProject(projectId, { settings: settingsStr as any })
    setProject((prev: any) => prev ? { ...prev, settings: settingsStr } : prev)
  }, [projectId, projectSettings, actions])

  const handleUpdateCanvasSettings = useCallback(async (themeSettings: Record<string, unknown>) => {
    await updateProjectSettings(themeSettings)
  }, [updateProjectSettings])

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

  // Auth headers for native (Android/iOS) — cookies aren't sent automatically
  const nativeHeaders = useMemo(() => {
    if (Platform.OS === 'web') return undefined
    return (): Record<string, string> => {
      const cookie = (authClient as any).getCookie()
      return cookie ? { Cookie: cookie } : {}
    }
  }, [])

  // Dynamic app canvas (agent projects)
  const { agentUrl } = useAgentUrl(API_URL!, projectId, {
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: nativeHeaders,
  })
  const { surfaces, activeSurfaceId, connected, dispatchAction, updateLocalData, reconnect, applyMessage } = useDynamicAppStream(
    agentUrl,
    {
      ...(nativeHeaders ? { headers: nativeHeaders } : {}),
      withCredentials: Platform.OS === 'web',
    },
  )
  const activeSurface = useMemo(() => {
    return activeSurfaceId ? surfaces.get(activeSurfaceId) || null : null
  }, [surfaces, activeSurfaceId])

  // Canvas action handler
  const handleCanvasAction = useCallback(
    (surfaceId: string, name: string, context?: Record<string, unknown>) => {
      dispatchAction(surfaceId, name, context)
    },
    [dispatchAction],
  )

  const handleCanvasPreview = useCallback(
    (surfaceId: string, components: any[]) => {
      applyMessage({ type: 'updateComponents', surfaceId, components })
    },
    [applyMessage],
  )

  // Auto-capture thumbnail when the agent finishes building the canvas UI (web only).
  const thumbnailCapturedRef = useRef(false)
  const hasCanvasUI = activeSurface && activeSurface.components.size > 0 && activeSurface.components.has('root')

  useEffect(() => {
    if (Platform.OS !== 'web') return
    if (!projectId || !hasCanvasUI || thumbnailCapturedRef.current) return

    let currentProject: any
    try {
      currentProject = store?.projectCollection?.all?.find((p: any) => p.id === projectId)
    } catch { return }
    if (currentProject?.thumbnailUrl) return

    thumbnailCapturedRef.current = true

    const timer = setTimeout(async () => {
      try {
        const { default: html2canvas } = await import('html2canvas')
        const canvasEl = document.querySelector('[data-thumbnail-target]') as HTMLElement
          ?? document.querySelector('[class*="flex-1"] [class*="p-4"]') as HTMLElement
        if (!canvasEl) return

        const canvas = await html2canvas(canvasEl, {
          scale: 0.5,
          useCORS: true,
          logging: false,
          backgroundColor: null,
          width: canvasEl.scrollWidth,
          height: Math.min(canvasEl.scrollHeight, 800),
        })

        canvas.toBlob(async (blob: Blob | null) => {
          if (!blob) return
          await api.uploadThumbnail(blob, projectId)
        }, 'image/png')
      } catch {}
    }, 1500)
    return () => clearTimeout(timer)
  }, [projectId, hasCanvasUI, store])

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

  const SESSION_PAGE_SIZE = 10

  // Auto-select or create chat session
  useEffect(() => {
    if (!projectId || !store?.chatSessionCollection || chatSessionId) return

    let cancelled = false

    const initSession = async () => {
      try {
        await store.chatSessionCollection.loadPage(
          { contextId: projectId },
          { limit: SESSION_PAGE_SIZE, offset: 0 },
        )
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

  const handleLoadMoreSessions = useCallback(async () => {
    if (!store?.chatSessionCollection || store.chatSessionCollection.isLoadingMore) return
    const currentCount = store.chatSessionCollection.all.filter(
      (s: any) => s.contextId === projectId,
    ).length
    try {
      await store.chatSessionCollection.loadPage(
        { contextId: projectId },
        { limit: SESSION_PAGE_SIZE, offset: currentCount },
      )
    } catch (err) {
      console.error('[ProjectLayout] Failed to load more chat sessions:', err)
    }
  }, [store, projectId])

  // Chat panel visibility
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [showChatSessions, setShowChatSessions] = useState(false)
  const [previewTab, setPreviewTab] = useState('dynamic-app')

  useEffect(() => {
    if (!canvasEnabled) {
      if (previewTab === 'dynamic-app') setPreviewTab('capabilities')
      if (activeTab === 'canvas') setActiveTab('chat')
    }
  }, [canvasEnabled, previewTab, activeTab])

  const handleCanvasToggle = useCallback(async (enabled: boolean) => {
    await updateProjectSettings({ canvasEnabled: enabled })
    if (agentUrl) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (nativeHeaders) Object.assign(headers, nativeHeaders())
        await fetch(`${agentUrl}/agent/config`, {
          method: 'PATCH',
          headers,
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          body: JSON.stringify({ canvasEnabled: enabled }),
        })
      } catch (err) {
        console.error('[ProjectLayout] Failed to push canvas config to runtime:', err)
      }
    }
    if (!enabled && previewTab === 'dynamic-app') {
      setPreviewTab('capabilities')
    }
  }, [updateProjectSettings, agentUrl, nativeHeaders, previewTab])

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
      billingData={features.billing ? billingData : { hasActiveSubscription: true, refetchCreditLedger: () => {} }}
      onCanvasPreview={handleCanvasPreview}
      className="flex-1"
    />
  )

  const canvasPanel = canvasEnabled ? (
    <CanvasThemeProvider projectSettings={project?.settings} onUpdateSettings={handleUpdateCanvasSettings}>
      <EditModeProvider agentUrl={agentUrl}>
        <CanvasPanel
          surface={activeSurface}
          connected={connected}
          agentUrl={agentUrl}
          onAction={handleCanvasAction}
          onDataChange={updateLocalData}
          authHeaders={nativeHeaders}
          onRefresh={reconnect}
        />
      </EditModeProvider>
    </CanvasThemeProvider>
  ) : null

  const hiddenTabs = canvasEnabled ? [] : ['dynamic-app']

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
            hasActiveSubscription={effectiveHasActiveSubscription}
            workspaceName={workspaceName}
            planLabel={planLabel}
            creditsRemaining={creditsRemaining}
            creditsTotal={creditsTotal}
            ownerName={user?.name || ''}
            projectCreatedAt={project.createdAt}
            projectModifiedAt={project.updatedAt}
            isStarred={isStarred}
            onRenameProject={handleRenameProject}
            onToggleStar={handleToggleStar}
            onMoveToFolder={handleMoveToFolder}
            folders={folders}
            hiddenTabs={hiddenTabs}
          />
          <View className="flex-1 flex-row">
            {!chatCollapsed && (
              <View className="w-[480px] border-r border-border">
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
                      onLoadMore={handleLoadMoreSessions}
                      hasMore={store?.chatSessionCollection?.hasMore ?? false}
                      isLoadingMore={store?.chatSessionCollection?.isLoadingMore ?? false}
                    />
                  </View>
                )}
                {chatPanel}
              </View>
            )}
            <View className="flex-1 relative">
              {canvasEnabled && (
                <View
                  className="absolute inset-0"
                  style={previewTab !== 'dynamic-app' ? { display: 'none' } : undefined}
                >
                  {canvasPanel}
                </View>
              )}
              <FilesBrowserPanel visible={previewTab === 'files'} projectId={projectId!} agentUrl={agentUrl} />
              <CapabilitiesPanel visible={previewTab === 'capabilities'} projectId={projectId!} agentUrl={agentUrl} canvasEnabled={canvasEnabled} onCanvasToggle={handleCanvasToggle} />
              <ChannelsPanel visible={previewTab === 'channels'} projectId={projectId!} agentUrl={agentUrl} />
              <MonitorPanel visible={previewTab === 'monitor'} projectId={projectId!} agentUrl={agentUrl} />
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
            hasActiveSubscription={effectiveHasActiveSubscription}
            workspaceName={workspaceName}
            planLabel={planLabel}
            creditsRemaining={creditsRemaining}
            creditsTotal={creditsTotal}
            ownerName={user?.name || ''}
            projectCreatedAt={project.createdAt}
            projectModifiedAt={project.updatedAt}
            isStarred={isStarred}
            onRenameProject={handleRenameProject}
            onToggleStar={handleToggleStar}
            onMoveToFolder={handleMoveToFolder}
            folders={folders}
            hiddenTabs={hiddenTabs}
            onTabChange={(tabId) => {
              setPreviewTab(tabId)
              if (tabId !== 'dynamic-app') setActiveTab('canvas')
            }}
          />
          <View className="flex-row border-b border-border">
            {(canvasEnabled ? ['chat', 'canvas'] as ActiveTab[] : ['chat'] as ActiveTab[]).map((tab) => (
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
                    : previewTab !== 'dynamic-app' && activeTab === 'canvas'
                      ? { capabilities: 'Capabilities', channels: 'Channels', monitor: 'Monitor' }[previewTab] ?? 'Canvas'
                      : `Canvas${activeSurface ? ` (${activeSurface.title || 'Live'})` : ''}`}
                </Text>
              </Pressable>
            ))}
            <Popover
              placement="bottom right"
              isOpen={showMoreMenu}
              onOpen={() => setShowMoreMenu(true)}
              onClose={() => setShowMoreMenu(false)}
              trigger={(triggerProps) => (
                <Pressable
                  {...triggerProps}
                  className={cn(
                    'px-3 py-3 items-center justify-center',
                    showMoreMenu && 'bg-muted',
                  )}
                >
                  <MoreHorizontal size={18} className="text-muted-foreground" />
                </Pressable>
              )}
            >
              <PopoverBackdrop />
              <PopoverContent className="min-w-[180px] p-0">
                <PopoverBody>
                  {([
                    { id: 'capabilities', label: 'Capabilities' },
                    { id: 'channels', label: 'Channels' },
                    { id: 'monitor', label: 'Monitor' },
                  ] as const).map((item) => (
                    <Pressable
                      key={item.id}
                      onPress={() => {
                        setActiveTab('canvas')
                        setPreviewTab(item.id)
                        setShowMoreMenu(false)
                      }}
                      className={cn(
                        'px-4 py-3 active:bg-muted',
                        previewTab === item.id && activeTab === 'canvas' && 'bg-accent',
                      )}
                    >
                      <Text
                        className={cn(
                          'text-sm',
                          previewTab === item.id && activeTab === 'canvas'
                            ? 'text-foreground font-medium'
                            : 'text-foreground',
                        )}
                      >
                        {item.label}
                      </Text>
                    </Pressable>
                  ))}
                </PopoverBody>
              </PopoverContent>
            </Popover>
          </View>
          {activeTab === 'chat' ? (
            chatPanel
          ) : previewTab === 'dynamic-app' && canvasEnabled ? (
            canvasPanel
          ) : (
            <View className="flex-1 relative">
              <FilesBrowserPanel visible={previewTab === 'files'} projectId={projectId!} agentUrl={agentUrl} />
              <CapabilitiesPanel visible={previewTab === 'capabilities'} projectId={projectId!} agentUrl={agentUrl} canvasEnabled={canvasEnabled} onCanvasToggle={handleCanvasToggle} />
              <ChannelsPanel visible={previewTab === 'channels'} projectId={projectId!} agentUrl={agentUrl} />
              <MonitorPanel visible={previewTab === 'monitor'} projectId={projectId!} agentUrl={agentUrl} />
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
  authHeaders,
  onRefresh,
}: {
  surface: any | null
  connected: boolean
  agentUrl: string | null
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
  onDataChange?: (surfaceId: string, path: string, value: unknown) => void
  authHeaders?: () => Record<string, string>
  onRefresh?: () => void
}) {
  const editMode = useEditModeOptional()
  const isEditMode = editMode?.isEditMode ?? false
  const showTreePanel = editMode?.showTreePanel ?? false
  const surfaceId = surface?.surfaceId ?? null

  const CONNECTION_TIMEOUT_MS = 60_000
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (connected && agentUrl) {
      setTimedOut(false)
      return
    }
    setTimedOut(false)
    const timer = setTimeout(() => setTimedOut(true), CONNECTION_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [connected, agentUrl])

  if (!agentUrl) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        {timedOut ? (
          <>
            <View className="w-3 h-3 rounded-full mb-3 bg-destructive" />
            <Text className="text-foreground font-semibold mb-1">
              Connection timed out
            </Text>
            <Text className="text-muted-foreground text-center text-sm">
              The agent runtime could not be reached. This may be a temporary issue — try refreshing or come back later.
            </Text>
            {onRefresh && (
              <Pressable
                onPress={onRefresh}
                className="mt-4 flex-row items-center gap-2 rounded-md border border-border px-4 py-2 active:opacity-70"
              >
                <RefreshCw size={14} className="text-muted-foreground" />
                <Text className="text-muted-foreground text-sm">Retry</Text>
              </Pressable>
            )}
          </>
        ) : (
          <>
            <ActivityIndicator size="large" className="mb-4" />
            <Text className="text-muted-foreground text-center">
              Connecting to agent runtime...
            </Text>
            <Text className="text-muted-foreground text-xs text-center mt-2">
              Send a message in the Chat tab to wake the agent
            </Text>
          </>
        )}
      </View>
    )
  }

  const themePicker = <CanvasThemePicker />

  if (!surface) {
    return (
      <View className="flex-1">
        <View className="flex-1 p-3">
          <CanvasThemedContainer>
            <EditToolbar surfaceId={null} trailing={themePicker} />
            <View className="flex-1 items-center justify-center px-6">
              <View
                className={cn(
                  'w-3 h-3 rounded-full mb-3',
                  connected ? 'bg-emerald-500' : timedOut ? 'bg-destructive' : 'bg-muted',
                )}
              />
              <Text className="text-foreground font-semibold mb-1">
                {connected
                  ? 'Connected'
                  : timedOut
                    ? 'Connection timed out'
                    : 'Waiting for connection...'}
              </Text>
              <Text className="text-muted-foreground text-center text-sm">
                {connected
                  ? 'The canvas will appear once the agent creates a UI. Ask it to build something!'
                  : timedOut
                    ? 'The agent runtime could not be reached. Try refreshing or come back later.'
                    : 'Connecting to the agent runtime...'}
              </Text>
              {(connected || timedOut) && onRefresh && (
                <Pressable
                  onPress={onRefresh}
                  className="mt-4 flex-row items-center gap-2 rounded-md border border-border px-4 py-2 active:opacity-70"
                >
                  <RefreshCw size={14} className="text-muted-foreground" />
                  <Text className="text-muted-foreground text-sm">{timedOut ? 'Retry' : 'Refresh'}</Text>
                </Pressable>
              )}
            </View>
          </CanvasThemedContainer>
        </View>
      </View>
    )
  }

  return (
    <View className="flex-1">
      <View className="flex-1 flex-row">
        {isEditMode && showTreePanel && (
          <ComponentTreePanel surfaceId={surfaceId} components={surface.components} />
        )}
        <View className="flex-1 p-3">
          <CanvasThemedContainer>
            <EditToolbar surfaceId={surfaceId} components={surface.components} trailing={themePicker} />
            <ScrollView
              className="flex-1"
              contentContainerStyle={{ padding: 16 }}
              {...(Platform.OS === 'web' ? { dataSet: { thumbnailTarget: '' } } as any : {})}
            >
              <DynamicAppRenderer
                surface={surface}
                agentUrl={agentUrl}
                onAction={onAction}
                onDataChange={onDataChange}
                authHeaders={authHeaders}
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
