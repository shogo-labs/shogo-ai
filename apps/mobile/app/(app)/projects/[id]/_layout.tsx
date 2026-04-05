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

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  useWindowDimensions,
  ScrollView,
  Platform,
  BackHandler,
  Keyboard,
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
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
import { useDomainHttp } from '../../../../contexts/domain'
import { authClient } from '../../../../lib/auth-client'
import { API_URL, api } from '../../../../lib/api'
import { usePlatformConfig } from '../../../../lib/platform-config'
import { consumePendingFiles } from '../../../../lib/pending-image-store'
import { isNativePhoneIntegrationsLayout } from '../../../../lib/native-phone-layout'
import { ChatPanel } from '../../../../components/chat/ChatPanel'
import type { InteractionMode } from '../../../../components/chat/ChatInput'
import { ChatSessionPicker, ChatSessionSidebar, type ChatSession } from '../../../../components/chat/ChatSessionPicker'
import { DynamicAppRenderer } from '../../../../components/dynamic-app/DynamicAppRenderer'
import { CanvasErrorBoundary } from '../../../../components/dynamic-app/CanvasErrorBoundary'
import { CanvasWebView } from '../../../../components/dynamic-app/CanvasWebView'
import { EditModeProvider, useEditModeOptional } from '../../../../components/dynamic-app/edit/EditModeContext'
import { AddComponentDialog } from '../../../../components/dynamic-app/edit/AddComponentDialog'
import { InspectorPanel } from '../../../../components/dynamic-app/edit/InspectorPanel'
import { ComponentTreePanel } from '../../../../components/dynamic-app/edit/ComponentTreePanel'
import { CanvasThemeProvider, CanvasThemedContainer, useCanvasThemeOptional } from '../../../../components/dynamic-app/CanvasThemeContext'
import { CanvasThemePicker } from '../../../../components/dynamic-app/CanvasThemePicker'
import { ProjectTopBar } from '../../../../components/project/ProjectTopBar'
import {
  ChannelsPanel,
  FilesBrowserPanel,
  CapabilitiesPanel,
  MonitorPanel,
  TerminalPanel,
  PlansPanel,
  AgentsPanel,
} from '../../../../components/project/panels'
import { RefreshCw, MessageSquare } from 'lucide-react-native'
import { subagentStreamStore } from '../../../../lib/subagent-stream-store'
import { IntegrationsCard, type TemplateIntegrationRef } from '../../../../components/project/IntegrationsCard'
import { parseToolInstallResult } from '../../../../components/chat/turns/ConnectToolWidget'

type ActiveTab = 'chat' | 'canvas'

const WIDE_BREAKPOINT = 1024
const HIDDEN_HEADER_OPTIONS = { headerShown: false } as const
const STANDALONE_PANELS = ['files', 'terminal', 'capabilities', 'channels', 'agents', 'monitor', 'plans']

export default observer(function ProjectLayout() {
  const params = useLocalSearchParams<{
    id: string
    chatSessionId?: string
    initialMessage?: string
    initialInteractionMode?: string
    appTemplateName?: string
    showIntegrations?: string
  }>()
  const projectId = params.id
  const { width, height } = useWindowDimensions()
  const isWide = width >= WIDE_BREAKPOINT
  const insets = useSafeAreaInsets()
  const nativePhone = isNativePhoneIntegrationsLayout(width, height)
  /** Handset + narrow project layout: float integrations above the composer. Tablets/web use default placement. */
  const liftIntegrationsAboveComposer = nativePhone && !isWide
  const { user } = useAuth()
  const http = useDomainHttp()

  const router = useRouter()
  const store = useSDKDomain() as IDomainStore
  const { isReady: sdkReady } = useSDKReady()
  const actions = useDomainActions()
  const projects = useProjectCollection()

  // Capture initialMessage and files once so they don't re-fire on re-renders
  const [capturedInitialMessage] = useState(() => params.initialMessage ?? undefined)
  const [capturedInitialInteractionMode] = useState<InteractionMode | undefined>(() => {
    const raw = params.initialInteractionMode
    const m = Array.isArray(raw) ? raw[0] : raw
    if (m === 'agent' || m === 'plan' || m === 'ask') return m
    return undefined
  })
  const [capturedInitialFiles] = useState(() => consumePendingFiles())
  // APP_MODE_DISABLED: capturedAppTemplateName removed
  const [capturedShowIntegrations] = useState(() => params.showIntegrations === '1')

  // Tab state for narrow screens
  const [activeTab, setActiveTab] = useState<ActiveTab>('chat')

  // Chat session tracking — seed from route param if provided
  const [chatSessionId, setChatSessionId] = useState<string | null>(
    () => params.chatSessionId ?? null
  )

  // Project state
  const [project, setProject] = useState<any>(null)
  const [isLoading, setIsLoading] = useState(true)

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
  const canvasMode = (projectSettings.canvasMode as 'json' | 'code') || 'json'
  const [iframeRefreshKey, setIframeRefreshKey] = useState(0)
  // APP_MODE_DISABLED: treat 'app' as 'none' for existing projects
  const rawMode = (projectSettings.activeMode as 'canvas' | 'app' | 'none') || (canvasEnabled ? 'canvas' : 'none')
  const activeMode = rawMode === 'app' ? 'none' : rawMode

  const capabilitySettings = useMemo(() => ({
    canvasEnabled: projectSettings.canvasEnabled !== false,
    webEnabled: projectSettings.webEnabled !== false,
    browserEnabled: projectSettings.browserEnabled !== false,
    shellEnabled: projectSettings.shellEnabled !== false,
    heartbeatEnabled: projectSettings.heartbeatEnabled !== false,
    imageGenEnabled: projectSettings.imageGenEnabled !== false,
    memoryEnabled: projectSettings.memoryEnabled !== false,
    quickActionsEnabled: projectSettings.quickActionsEnabled !== false,
  }), [projectSettings])

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

  // Resolve agent + preview URLs
  const { agentUrl, previewUrl, canvasBaseUrl } = useAgentUrl(API_URL!, projectId, {
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: nativeHeaders,
  })

  // APP_MODE_DISABLED: app template copy effect removed

  // Dynamic app canvas — all unified projects use the agent URL for canvas streaming
  const dynamicAppStreamUrl = agentUrl
  const { surfaces, activeSurfaceId, connected, dispatchAction, updateLocalData, reconnect, applyMessage } = useDynamicAppStream(
    dynamicAppStreamUrl,
    {
      ...(nativeHeaders ? { headers: nativeHeaders } : {}),
      withCredentials: Platform.OS === 'web',
    },
  )
  const [userSelectedSurfaceId, setUserSelectedSurfaceId] = useState<string | null>(null)
  const mountTimeRef = useRef(Date.now())

  // Restore last-viewed surface from AsyncStorage
  useEffect(() => {
    if (!projectId) return
    AsyncStorage.getItem(`shogo:lastCanvasSurface:${projectId}`).then((savedId) => {
      if (savedId) setUserSelectedSurfaceId(savedId)
    }).catch(() => {})
  }, [projectId])

  const effectiveSurfaceId = userSelectedSurfaceId && surfaces.has(userSelectedSurfaceId)
    ? userSelectedSurfaceId
    : activeSurfaceId

  // Persist active surface selection to AsyncStorage
  useEffect(() => {
    if (projectId && effectiveSurfaceId) {
      AsyncStorage.setItem(`shogo:lastCanvasSurface:${projectId}`, effectiveSurfaceId).catch(() => {})
    }
  }, [projectId, effectiveSurfaceId])

  const activeSurface = useMemo(() => {
    return effectiveSurfaceId ? surfaces.get(effectiveSurfaceId) || null : null
  }, [surfaces, effectiveSurfaceId])

  const surfaceEntries = useMemo(() =>
    Array.from(surfaces.values())
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
      .map(s => ({ id: s.surfaceId, title: s.title || s.surfaceId })),
    [surfaces],
  )

  const surfaceIds = useMemo(() =>
    surfaceEntries.map(s => s.id),
    [surfaceEntries],
  )

  // Auto-switch to new surfaces created by the agent.
  // Suppressed for the first 2 s after mount so the SSE replay doesn't
  // override the surface selection we just restored from AsyncStorage.
  const prevActiveSurfaceIdRef = useRef(activeSurfaceId)
  useEffect(() => {
    if (Date.now() - mountTimeRef.current < 2000) {
      prevActiveSurfaceIdRef.current = activeSurfaceId
      return
    }
    if (activeSurfaceId && activeSurfaceId !== prevActiveSurfaceIdRef.current) {
      setUserSelectedSurfaceId(null)
    }
    prevActiveSurfaceIdRef.current = activeSurfaceId
  }, [activeSurfaceId])

  // Canvas action handler
  const handleCanvasAction = useCallback(
    (surfaceId: string, name: string, context?: Record<string, unknown>) => {
      dispatchAction(surfaceId, name, context)
    },
    [dispatchAction],
  )

  const handleCanvasPreview = useCallback(
    (surfaceId: string, components: any[]) => {
      applyMessage({ type: 'updateComponents', surfaceId, components, merge: true })
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

    const isAccessDenied = (err: any) => {
      const status = err?.status
      const code = err?.code
      return status === 403 || status === 404 || code === 'FORBIDDEN' || code === 'NOT_FOUND'
    }

    const loadProject = async (attempt = 1): Promise<void> => {
      if (cancelled) return
      setIsLoading(true)

      try {
        await store.workspaceCollection.loadAll({ userId: user!.id })
        store.projectCollection.loadAll().catch((e) => console.error('[ProjectLayout] Failed to preload projects:', e))
        const proj = await store.projectCollection.loadById(projectId)

        if (cancelled) return

        if (proj) {
          setProject(proj)
          setIsLoading(false)
        } else if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
          return loadProject(attempt + 1)
        } else {
          console.warn('[ProjectLayout] Project not found after retries, redirecting home:', projectId)
          router.replace('/(app)')
        }
      } catch (err: any) {
        if (cancelled) return
        if (isAccessDenied(err)) {
          console.warn('[ProjectLayout] Access denied to project, redirecting home:', projectId)
          router.replace('/(app)')
          return
        }
        const isTransient =
          err?.message?.includes('Schema') || err?.message?.includes('not found')
        if (isTransient && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt))
          return loadProject(attempt + 1)
        }
        console.error('[ProjectLayout] Failed to load project:', err)
        router.replace('/(app)')
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
      AsyncStorage.setItem(`shogo:lastChatSession:${projectId}`, chatSessionId).catch((e) => console.error('[ProjectLayout] Failed to persist chat session:', e))
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
  const [chatMessages, setChatMessages] = useState<any[]>([])
  const [buildPlanRequest, setBuildPlanRequest] = useState<{ plan: any; agentMode: any; nonce: number } | null>(null)
  const [planRefreshNonce, setPlanRefreshNonce] = useState(0)
  const [selectedAgentToolId, setSelectedAgentToolId] = useState<string | null>(null)

  useEffect(() => {
    if (!canvasEnabled) {
      if (previewTab === 'dynamic-app' || previewTab === 'app-preview') {
        setPreviewTab('chat-fullscreen')
      }
      if (
        activeTab === 'canvas' &&
        previewTab !== 'app-preview' &&
        !STANDALONE_PANELS.includes(previewTab)
      ) {
        setActiveTab('chat')
      }
    } else if (canvasEnabled) {
      if (previewTab === 'chat-fullscreen') setPreviewTab('dynamic-app')
      if (previewTab === 'app-preview') setPreviewTab('dynamic-app')
    }
  }, [canvasEnabled, activeMode, previewTab, activeTab])

  // Narrow + Android: back from Capabilities → chat column, with Canvas preview selected when canvas is on.
  useEffect(() => {
    if (Platform.OS !== 'android' || isWide) return

    const onBack = () => {
      if (previewTab !== 'capabilities') return false
      setActiveTab('chat')
      setPreviewTab(canvasEnabled ? 'dynamic-app' : 'chat-fullscreen')
      return true
    }

    const sub = BackHandler.addEventListener('hardwareBackPress', onBack)
    return () => sub.remove()
  }, [isWide, previewTab, canvasEnabled])

  const handlePreviewTabChange = useCallback((tabId: string) => {
    if (Platform.OS === 'web') {
      try {
        ;(document.activeElement as HTMLElement)?.blur?.()
      } catch {
        /* ignore */
      }
    }
    setPreviewTab(tabId)
  }, [])

  useEffect(() => {
    subagentStreamStore.onRequestTabSwitch((toolId?: string) => {
      setSelectedAgentToolId(toolId ?? null)
      setPreviewTab('agents')
      if (!isWide) setActiveTab('canvas')
    })
    return () => subagentStreamStore.onRequestTabSwitch(null)
  }, [isWide])

  const handleCapabilityToggle = useCallback(async (key: string, enabled: boolean) => {
    await updateProjectSettings({ [key]: enabled })
    if (agentUrl) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (nativeHeaders) Object.assign(headers, nativeHeaders())
        await fetch(`${agentUrl}/agent/config`, {
          method: 'PATCH',
          headers,
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          body: JSON.stringify({ [key]: enabled }),
        })
      } catch (err) {
        console.error(`[ProjectLayout] Failed to push ${key} config to runtime:`, err)
      }
    }
    if (key === 'canvasEnabled' && !enabled && previewTab === 'dynamic-app') {
      setPreviewTab('chat-fullscreen')
    }
  }, [updateProjectSettings, agentUrl, nativeHeaders, previewTab])

  const handleManualModeChange = useCallback(async (mode: 'canvas' | 'none') => {
    const enableCanvas = mode === 'canvas'

    await updateProjectSettings({ activeMode: mode, canvasEnabled: enableCanvas })

    if (agentUrl) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (nativeHeaders) Object.assign(headers, nativeHeaders())
        await fetch(`${agentUrl}/agent/config`, {
          method: 'PATCH',
          headers,
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          body: JSON.stringify({ activeMode: mode, canvasEnabled: enableCanvas }),
        })
      } catch (err) {
        console.error('[ProjectLayout] Failed to push mode config to runtime:', err)
      }
    }

    if (!enableCanvas) {
      setActiveTab('chat')
      setPreviewTab('chat-fullscreen')
    } else if (
      !isWide &&
      previewTab === 'capabilities' &&
      enableCanvas &&
      activeMode === 'none'
    ) {
      setActiveTab('chat')
      setPreviewTab('dynamic-app')
    }
  }, [isWide, updateProjectSettings, agentUrl, nativeHeaders, previewTab, activeMode])

  const handleBuildPlan = useCallback((plan: any, agentMode: any) => {
    setBuildPlanRequest({ plan, agentMode, nonce: Date.now() })
    setActiveTab('chat')
    if (canvasEnabled) {
      setPreviewTab('dynamic-app')
    } else {
      setPreviewTab('chat-fullscreen')
    }
  }, [canvasEnabled])

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

  // ─── Integrations card state ───────────────────────────────
  const [integrationsCardData, setIntegrationsCardData] = useState<{
    integrations: TemplateIntegrationRef[]
    templateName: string
  } | null>(null)
  const [integrationsCardDismissed, setIntegrationsCardDismissed] = useState(false)

  useEffect(() => {
    console.log('[ProjectLayout] integrations check:', { capturedShowIntegrations, templateId: project?.templateId, projectKeys: project ? Object.keys(project) : null })
    if (!capturedShowIntegrations || !project?.templateId) return
    let cancelled = false

    async function lookupIntegrations() {
      try {
        const templates = await api.getAgentTemplates(http)
        if (cancelled) return
        console.log('[ProjectLayout] templates fetched:', templates.length, 'looking for:', project.templateId)
        const match = templates.find((t: any) => t.id === project.templateId)
        if (match?.integrations?.length) {
          setIntegrationsCardData({
            integrations: match.integrations,
            templateName: match.name,
          })
        }
      } catch (err) {
        console.warn('[ProjectLayout] Failed to look up template integrations:', err)
      }
    }

    lookupIntegrations()
    return () => { cancelled = true }
  }, [capturedShowIntegrations, project?.templateId])

  const pendingToolInstalls = useMemo(() => {
    const pending: { toolkit: string; displayName: string }[] = []
    const seen = new Set<string>()
    for (const msg of chatMessages) {
      const parts = (msg as any).parts as any[] | undefined
      if (!parts) continue
      for (const part of parts) {
        if (part.type !== 'tool-invocation' && part.type !== 'dynamic-tool') continue
        const toolName = part.toolInvocation?.toolName ?? part.toolName
        if (toolName !== 'tool_install') continue
        const state = part.toolInvocation?.state ?? part.state
        if (state !== 'result' && state !== 'output-available') continue
        const result = parseToolInstallResult(
          part.toolInvocation?.result ?? part.output
        )
        if (result?.authStatus === 'needs_auth' && result?.integration && !seen.has(result.integration)) {
          seen.add(result.integration)
          pending.push({
            toolkit: result.integration,
            displayName: result.integration.charAt(0).toUpperCase() + result.integration.slice(1),
          })
        }
      }
    }
    return pending
  }, [chatMessages])

  const showIntegrationsCard =
    !integrationsCardDismissed && (
      (capturedShowIntegrations && integrationsCardData != null) ||
      pendingToolInstalls.length > 0
    )

  /** Native phone + narrow layout: float only on Chat tab (not Canvas / Files / Terminal / …). Web, tablet, and wide layouts unchanged. */
  const showIntegrationsCardUi =
    showIntegrationsCard && (!nativePhone || isWide || activeTab === 'chat')

  const narrowOnCanvas = !isWide && activeTab === 'canvas'
  /** Native-only: float above Files / Terminal / … (those layers use z-20). Omit on Expo web so web layout stays unchanged. */
  const showNativeNarrowChatFab = narrowOnCanvas && Platform.OS !== 'web'

  /** Keeps the narrow-mode Chat FAB above the software keyboard (absolute positioning ignores keyboard inset). Web unchanged. */
  const [narrowCanvasKeyboardInset, setNarrowCanvasKeyboardInset] = useState(0)
  useEffect(() => {
    if (!showNativeNarrowChatFab) {
      setNarrowCanvasKeyboardInset(0)
      return
    }
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const subShow = Keyboard.addListener(showEvt, (e) => {
      setNarrowCanvasKeyboardInset(e.endCoordinates.height)
    })
    const subHide = Keyboard.addListener(hideEvt, () => setNarrowCanvasKeyboardInset(0))
    return () => {
      subShow.remove()
      subHide.remove()
    }
  }, [showNativeNarrowChatFab])

  // Loading state
  if (isLoading || !project) {
    return (
      <>
        <Stack.Screen options={HIDDEN_HEADER_OPTIONS} />
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
      projectType="unified"
      initialMessage={capturedInitialMessage}
      initialInteractionMode={capturedInitialInteractionMode}
      initialFiles={capturedInitialFiles}
      billingData={features.billing ? billingData : { hasActiveSubscription: true, hasAdvancedModelAccess: true, refetchCreditLedger: () => {} }}
      onCanvasPreview={handleCanvasPreview}
      onMessagesChange={setChatMessages}
      buildPlanRequest={buildPlanRequest}
      onPlanCreated={() => setPlanRefreshNonce((n) => n + 1)}
      className="flex-1"
    />
  )

  const canvasPanel = canvasEnabled ? (
    <CanvasPanel
      surface={activeSurface}
      surfaces={surfaces}
      activeSurfaceId={effectiveSurfaceId}
      onSurfaceChange={setUserSelectedSurfaceId}
      connected={connected}
      agentUrl={agentUrl}
      canvasBaseUrl={canvasBaseUrl}
      onAction={handleCanvasAction}
      onDataChange={updateLocalData}
      authHeaders={nativeHeaders}
      onRefresh={reconnect}
      fullBleed={!isWide}
      canvasMode={canvasMode}
      iframeRefreshKey={iframeRefreshKey}
    />
  ) : null

  const hiddenTabs: string[] = ['app-preview'] // APP_MODE_DISABLED: always hide app-preview
  if (activeMode !== 'none') hiddenTabs.push('chat-fullscreen')
  if (activeMode !== 'canvas') hiddenTabs.push('dynamic-app')

  const isChatFullscreen = isWide && activeMode === 'none' && previewTab === 'chat-fullscreen'

  const chatHidden = isWide ? (isChatFullscreen || chatCollapsed) : activeTab !== 'chat'
  const canvasAreaHidden = (!isWide && activeTab === 'chat') || isChatFullscreen

  const topBarSharedProps = {
    projectName: project.name,
    projectId: projectId!,
    projects: allProjects,
    activeTab: previewTab,
    hasActiveSubscription: effectiveHasActiveSubscription,
    workspaceName,
    planLabel,
    creditsRemaining,
    creditsTotal,
    ownerName: user?.name || '',
    projectCreatedAt: project.createdAt,
    projectModifiedAt: project.updatedAt,
    isStarred,
    onRenameProject: handleRenameProject,
    onToggleStar: handleToggleStar,
    onMoveToFolder: handleMoveToFolder,
    folders,
    hiddenTabs,
    canvasEnabled,
    activeMode,
    surfaceEntries,
    activeSurfaceId: effectiveSurfaceId,
    onSurfaceChange: setUserSelectedSurfaceId,
    showChatSessions: isChatFullscreen ? false : showChatSessions,
    isChatCollapsed: isChatFullscreen ? true : chatCollapsed,
    onChatSessionsToggle: isChatFullscreen ? undefined : () => setShowChatSessions((s: boolean) => !s),
    onChatCollapseToggle: isChatFullscreen ? undefined : () => setChatCollapsed((c: boolean) => !c),
    onCreateNewSession: isChatFullscreen ? undefined : handleCreateNewSession,
    chatFullscreenSidebarWidth: isChatFullscreen ? 280 : undefined,
    canvasActive: canvasEnabled && previewTab === 'dynamic-app',
    effectiveSurfaceId,
    onCanvasRefresh: canvasMode === 'code' ? () => setIframeRefreshKey(k => k + 1) : undefined,
  }

  return (
    <>
      <Stack.Screen options={HIDDEN_HEADER_OPTIONS} />

      <CanvasThemeProvider projectSettings={projectSettings} onUpdateSettings={handleUpdateCanvasSettings} activeSurfaceId={effectiveSurfaceId} surfaceIds={surfaceIds}>
        <EditModeProvider agentUrl={agentUrl}>
          <View className="flex-1 bg-background">
            {isWide ? (
              <TopBarBridge
                {...topBarSharedProps}
                onTabChange={handlePreviewTabChange}
              />
            ) : (
              <TopBarBridge
                {...topBarSharedProps}
                narrowActiveTab={activeTab}
                narrowPreviewTab={previewTab}
                onNarrowTabChange={(tab: 'chat' | 'canvas') => {
                  setActiveTab(tab)
                  if (tab === 'canvas') {
                    setPreviewTab('dynamic-app')
                  } else {
                    // Clear standalone preview (files, capabilities, …) so the chat column shows
                    // and the next “canvas” visit doesn’t reopen the old panel on top.
                    setPreviewTab(!canvasEnabled ? 'chat-fullscreen' : 'dynamic-app')
                  }
                }}
                onTabChange={(tabId: string) => {
                  handlePreviewTabChange(tabId)
                  if (tabId !== 'dynamic-app' && tabId !== 'app-preview' && tabId !== 'chat-fullscreen') setActiveTab('canvas')
                }}
              />
            )}

            {/* Content — chat panel stays mounted across layout/tab changes */}
            <View className={cn('flex-1', isWide && 'flex-row')}>
              {/* Full-screen chat with history sidebar (canvas disabled, Chat tab active) */}
              {isChatFullscreen && (
                <View className="flex-1 flex-row">
                  <View className="w-[280px] bg-muted/50 dark:bg-black/30">
                    <ChatSessionSidebar
                      sessions={chatSessions}
                      currentSessionId={chatSessionId ?? undefined}
                      onSelect={(sessionId) => setChatSessionId(sessionId)}
                      onCreate={handleCreateNewSession}
                      onLoadMore={handleLoadMoreSessions}
                      hasMore={store?.chatSessionCollection?.hasMore ?? false}
                      isLoadingMore={store?.chatSessionCollection?.isLoadingMore ?? false}
                    />
                  </View>
                  <View className="flex-1">
                    {chatPanel}
                  </View>
                </View>
              )}

              {/* Left chat panel */}
              {!isChatFullscreen && (
                <View
                  className={cn(
                    'flex min-h-0 flex-col',
                    isWide ? 'w-[480px] shrink-0 bg-background z-10' : 'relative flex-1',
                    chatHidden && 'hidden',
                  )}
                >
                  {isWide && showChatSessions && (
                    <View className="shrink-0 border-b border-border bg-background">
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
                  <View className="min-h-0 flex-1">{chatPanel}</View>
                </View>
              )}

          {/* Right panel area (canvas / files / capabilities / channels / monitor) */}
          <View
            className={cn(
              'relative flex-1 overflow-hidden',
              canvasAreaHidden && 'hidden',
              Platform.OS === 'web' && !canvasAreaHidden && 'min-h-0',
            )}
          >
            {/* Floating chat button on native narrow canvas — above every canvas sub-tab (z-20 panels) */}
            {showNativeNarrowChatFab && (
              <SafeAreaView
                edges={['bottom']}
                className="absolute bottom-0 right-0 z-30 pr-4 pb-4"
                pointerEvents="box-none"
                style={
                  narrowCanvasKeyboardInset > 0
                    ? { marginBottom: narrowCanvasKeyboardInset }
                    : undefined
                }
              >
                <Pressable
                  onPress={() => {
                    setActiveTab('chat')
                    setPreviewTab(!canvasEnabled ? 'chat-fullscreen' : 'dynamic-app')
                  }}
                  className="flex-row items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 shadow-lg"
                >
                  <MessageSquare size={16} className="text-primary-foreground" />
                  <Text className="text-sm font-semibold text-primary-foreground">Chat</Text>
                </Pressable>
              </SafeAreaView>
            )}

            {canvasEnabled && previewTab === 'dynamic-app' && (
              <View className="absolute inset-0">{canvasPanel}</View>
            )}
            {previewTab === 'app-preview' && (
              <View
                className={cn(
                  'absolute inset-0 overflow-hidden',
                  Platform.OS === 'web' && 'z-0',
                )}
              >
                <AppPreviewPanel previewUrl={previewUrl ?? null} agentUrl={agentUrl ?? null} />
              </View>
            )}
            <View
              className={cn(
                'absolute inset-0',
                STANDALONE_PANELS.includes(previewTab)
                  ? 'z-20 bg-background'
                  : 'pointer-events-none',
              )}
              pointerEvents={
                STANDALONE_PANELS.includes(previewTab)
                  ? 'auto'
                  : 'none'
              }
            >
              <FilesBrowserPanel visible={previewTab === 'files'} projectId={projectId!} agentUrl={agentUrl} />
              <TerminalPanel visible={previewTab === 'terminal'} messages={chatMessages} />
              <CapabilitiesPanel visible={previewTab === 'capabilities'} projectId={projectId!} agentUrl={agentUrl} capabilities={capabilitySettings} onCapabilityToggle={handleCapabilityToggle} isPaidPlan={effectiveHasActiveSubscription} activeMode={activeMode} onModeChange={handleManualModeChange} />
              <ChannelsPanel visible={previewTab === 'channels'} projectId={projectId!} agentUrl={agentUrl} hasAdvancedModelAccess={features.billing ? billingData.hasAdvancedModelAccess : true} />
              <AgentsPanel visible={previewTab === 'agents'} selectedToolId={selectedAgentToolId} />
              <MonitorPanel visible={previewTab === 'monitor'} projectId={projectId!} agentUrl={agentUrl} isPaidPlan={effectiveHasActiveSubscription} />
              <PlansPanel visible={previewTab === 'plans'} projectId={projectId!} agentUrl={agentUrl} onBuildPlan={handleBuildPlan} refreshTrigger={planRefreshNonce} />
            </View>
          </View>

          {/* Floating integrations card */}
          {showIntegrationsCardUi && (
            <View
              className={cn(
                'absolute z-30',
                liftIntegrationsAboveComposer ? 'right-3' : 'bottom-4 right-4',
              )}
              style={
                liftIntegrationsAboveComposer
                  ? { bottom: insets.bottom + 84 }
                  : undefined
              }
              pointerEvents="box-none"
            >
              <IntegrationsCard
                projectId={projectId!}
                integrations={integrationsCardData?.integrations}
                templateName={integrationsCardData?.templateName}
                pendingToolkits={pendingToolInstalls}
                onDismiss={() => setIntegrationsCardDismissed(true)}
              />
            </View>
          )}
          </View>
        </View>
      </EditModeProvider>
    </CanvasThemeProvider>
    </>
  )
})

// ---------------------------------------------------------------------------
// TopBarBridge — reads EditModeContext and passes values to ProjectTopBar
// ---------------------------------------------------------------------------

function TopBarBridge({
  canvasActive,
  effectiveSurfaceId,
  surfaceEntries,
  ...props
}: React.ComponentProps<typeof ProjectTopBar> & {
  canvasActive: boolean
  effectiveSurfaceId: string | null
}) {
  const editMode = useEditModeOptional()
  const [showAddDialog, setShowAddDialog] = useState(false)
  const canvasTheme = useCanvasThemeOptional()

  const themedSurfaceEntries = useMemo(() => {
    if (!surfaceEntries || !canvasTheme) return surfaceEntries
    return surfaceEntries.map((s) => ({
      ...s,
      themeSwatchColor: canvasTheme.getSwatchForSurface(s.id),
    }))
  }, [surfaceEntries, canvasTheme])

  const handleDelete = useCallback(() => {
    if (effectiveSurfaceId && editMode?.selectedComponentId) {
      editMode.deleteComponent(effectiveSurfaceId, editMode.selectedComponentId)
    }
  }, [effectiveSurfaceId, editMode])

  const isEditActive = canvasActive && editMode?.isEditMode

  return (
    <>
      <ProjectTopBar
        {...props}
        surfaceEntries={themedSurfaceEntries}
        isEditMode={canvasActive ? editMode?.isEditMode : undefined}
        onToggleEditMode={canvasActive ? editMode?.toggleEditMode : undefined}
        showTreePanel={canvasActive ? editMode?.showTreePanel : undefined}
        onToggleTreePanel={canvasActive ? editMode?.toggleTreePanel : undefined}
        selectedComponentId={canvasActive ? editMode?.selectedComponentId : undefined}
        onDeleteComponent={
          isEditActive && editMode?.selectedComponentId && editMode.selectedComponentId !== 'root'
            ? handleDelete
            : undefined
        }
        onAddComponent={isEditActive ? () => setShowAddDialog(true) : undefined}
        canvasThemePicker={canvasActive ? <CanvasThemePicker /> : undefined}
      />
      {showAddDialog && effectiveSurfaceId && (
        <AddComponentDialog
          visible={showAddDialog}
          onClose={() => setShowAddDialog(false)}
          surfaceId={effectiveSurfaceId}
          parentId={editMode?.selectedComponentId || 'root'}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Canvas Panel — renders dynamic app surfaces or runtime preview placeholder
// ---------------------------------------------------------------------------

/** Polls the preview root URL until it stops returning 404.
 *  Covers both DomainMapping propagation (ingress 404 / CORS error)
 *  and runtime deployment (old pods serve /canvas/* but not /). */
function usePreviewReadiness(baseUrl: string | null | undefined): string | null {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!baseUrl) { setReady(false); return }

    let alive = true

    async function poll() {
      for (let i = 0; i < 60 && alive; i++) {
        try {
          const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(4000) })
          if (res.status !== 404) { if (alive) setReady(true); return }
        } catch { /* CORS / network failure — DomainMapping not ready */ }
        await new Promise(r => setTimeout(r, 1000))
      }
      if (alive) setReady(true)
    }

    poll()
    return () => { alive = false }
  }, [baseUrl])

  return ready ? baseUrl! : null
}

function CanvasPanel({
  surface,
  surfaces,
  activeSurfaceId,
  onSurfaceChange,
  connected,
  agentUrl,
  canvasBaseUrl,
  onAction,
  onDataChange,
  authHeaders,
  onRefresh,
  fullBleed,
  canvasMode = 'json',
  iframeRefreshKey = 0,
}: {
  surface: any | null
  surfaces: Map<string, any>
  activeSurfaceId: string | null
  onSurfaceChange: (surfaceId: string) => void
  connected: boolean
  agentUrl: string | null
  canvasBaseUrl?: string | null
  onAction: (surfaceId: string, name: string, context?: Record<string, unknown>) => void
  onDataChange?: (surfaceId: string, path: string, value: unknown) => void
  authHeaders?: () => Record<string, string>
  onRefresh?: () => void
  fullBleed?: boolean
  canvasMode?: 'json' | 'code'
  iframeRefreshKey?: number
}) {
  const editMode = useEditModeOptional()
  const isEditMode = editMode?.isEditMode ?? false
  const showTreePanel = editMode?.showTreePanel ?? false
  const surfaceId = surface?.surfaceId ?? null

  // Poll the preview URL's /health endpoint until the DomainMapping propagates.
  // Until ready, treat canvasBaseUrl as null so the loading screen stays visible.
  const readyCanvasBaseUrl = usePreviewReadiness(canvasBaseUrl)

  const CONNECTION_TIMEOUT_MS = 60_000
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (connected && agentUrl && readyCanvasBaseUrl) {
      setTimedOut(false)
      return
    }
    setTimedOut(false)
    const timer = setTimeout(() => setTimedOut(true), CONNECTION_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [connected, agentUrl, readyCanvasBaseUrl])

  if (!agentUrl || !readyCanvasBaseUrl) {
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

  // Canvas v2: render the CanvasWebView (parent owns SSE, bridges via postMessage)
  if (canvasMode === 'code') {
    return (
      <View className="flex-1 overflow-hidden rounded-2xl mx-2 mb-2">
        <CanvasWebView agentUrl={agentUrl} canvasBaseUrl={readyCanvasBaseUrl} activeSurfaceId={activeSurfaceId} refreshKey={iframeRefreshKey} />
      </View>
    )
  }

  if (!surface) {
    return (
      <View className="flex-1">
        <View className={cn('flex-1', !fullBleed && 'p-2')}>
          <CanvasThemedContainer noBorder={fullBleed}>
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
        <View className={cn('flex-1', !fullBleed && 'p-2')}>
          <CanvasThemedContainer noBorder={fullBleed}>
            <ScrollView
              className="flex-1"
              contentContainerClassName={fullBleed ? 'p-0' : 'p-4'}
              {...(Platform.OS === 'web' ? { dataSet: { thumbnailTarget: '' } } as any : {})}
            >
              <CanvasErrorBoundary surfaceTitle={surface?.title}>
                <DynamicAppRenderer
                  surface={surface}
                  agentUrl={agentUrl}
                  onAction={onAction}
                  onDataChange={onDataChange}
                  authHeaders={authHeaders}
                />
              </CanvasErrorBoundary>
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

// ---------------------------------------------------------------------------
// App Preview Panel — iframe (web) for APP project live preview
// ---------------------------------------------------------------------------

const PHASE_LABELS: Record<string, string> = {
  idle: 'Preparing environment...',
  installing: 'Installing dependencies...',
  'generating-prisma': 'Setting up database...',
  'pushing-db': 'Initializing database...',
  building: 'Building app...',
  'starting-api': 'Starting API server...',
  ready: 'Ready',
}

function AppPreviewPanel({ previewUrl, agentUrl }: { previewUrl: string | null; agentUrl: string | null }) {
  const [iframeKey, setIframeKey] = useState(0)
  const [previewReady, setPreviewReady] = useState(false)
  const [phase, setPhase] = useState<string>('idle')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!agentUrl || previewReady) return

    let cancelled = false
    const poll = async () => {
      try {
        const resp = await fetch(`${agentUrl}/preview/status`, {
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          signal: AbortSignal.timeout(5000),
        })
        if (cancelled) return
        if (resp.ok) {
          const data = await resp.json()
          if (data.phase) setPhase(data.phase)
          if (data.running) {
            setPreviewReady(true)
            setIframeKey(k => k + 1)
          }
        }
      } catch {
        // Pod may not be reachable yet
      }
    }

    poll()
    pollRef.current = setInterval(poll, 3000)

    return () => {
      cancelled = true
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [agentUrl, previewReady])

  // Reset ready state when previewUrl changes (new project)
  useEffect(() => {
    setPreviewReady(false)
    setPhase('idle')
  }, [previewUrl])

  if (!previewUrl) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <ActivityIndicator size="large" className="mb-4" />
        <Text className="text-muted-foreground text-center">
          Connecting to preview server...
        </Text>
      </View>
    )
  }

  if (Platform.OS === 'web') {
    return (
      <View className="flex-1 relative">
        <Pressable
          onPress={() => {
            setIframeKey((k) => k + 1)
            if (!previewReady) setPreviewReady(false)
          }}
          className="absolute top-2 right-2 z-10 rounded-md border border-border bg-background/80 px-3 py-1.5 active:opacity-70"
        >
          <Text className="text-muted-foreground text-xs">Refresh</Text>
        </Pressable>

        {!previewReady && (
          <View className="absolute inset-0 z-[5] items-center justify-center bg-background/90">
            <ActivityIndicator size="large" className="mb-4" />
            <Text className="text-foreground font-medium text-base mb-1">
              {PHASE_LABELS[phase] || 'Preparing preview...'}
            </Text>
            <Text className="text-muted-foreground text-xs">
              This usually takes 20-40 seconds
            </Text>
          </View>
        )}

        <iframe
          key={iframeKey}
          src={previewReady ? previewUrl : 'about:blank'}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          className="block h-full w-full border-0"
          {...{ 'data-thumbnail-target': '' } as any}
        />
      </View>
    )
  }

  return (
    <View className="flex-1 items-center justify-center px-6">
      <Text className="text-muted-foreground text-center">
        Preview is available in the web browser
      </Text>
    </View>
  )
}
