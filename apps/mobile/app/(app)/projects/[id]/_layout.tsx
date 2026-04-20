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
  Alert,
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
  getChatMessageCollectionForSession,
} from '@shogo/shared-app/domain'
import {
  useDynamicAppStream,
  useAgentUrl,
} from '@shogo/shared-app/dynamic-app'
import type { IDomainStore } from '@shogo/domain-stores'
import { cn } from '@shogo/shared-ui/primitives'
import { useBillingData } from '@shogo/shared-app/hooks'
import {
  getTotalCreditsForPlan,
  getCreditsCapacityForDisplay,
  getPlanDisplayName,
} from '../../../../lib/billing-config'
import { useAuth } from '../../../../contexts/auth'
import { useDomainHttp } from '../../../../contexts/domain'
import { authClient } from '../../../../lib/auth-client'
import { API_URL, api } from '../../../../lib/api'
import { usePlatformConfig } from '../../../../lib/platform-config'
import { consumePendingFiles } from '../../../../lib/pending-image-store'
import { isNativePhoneIntegrationsLayout } from '../../../../lib/native-phone-layout'
import { ChatPanel } from '../../../../components/chat/ChatPanel'
import { PlanStreamProvider } from '../../../../components/chat/PlanStreamContext'
import type { InteractionMode } from '../../../../components/chat/ChatInput'
import { DEFAULT_MODEL_PRO, DEFAULT_MODEL_FREE } from '../../../../components/chat/ChatInput'
import { loadModelPreference, saveModelPreference } from '../../../../lib/agent-mode-preference'
import { MODEL_CATALOG } from '@shogo/model-catalog'
import { agentFetch } from '../../../../lib/agent-fetch'
import { useActiveInstance } from '../../../../contexts/active-instance'
import { ChatSessionPicker, ChatSessionSidebar, type ChatSession } from '../../../../components/chat/ChatSessionPicker'
import { ChatTabBar, type ChatTab } from '../../../../components/chat/ChatTabBar'
import { DynamicAppRenderer } from '../../../../components/dynamic-app/DynamicAppRenderer'
import { CanvasErrorBoundary } from '../../../../components/dynamic-app/CanvasErrorBoundary'
import { CanvasWebView } from '../../../../components/dynamic-app/CanvasWebView'
import { EditModeProvider, useEditModeOptional } from '../../../../components/dynamic-app/edit/EditModeContext'
import { AddComponentDialog } from '../../../../components/dynamic-app/edit/AddComponentDialog'
import { InspectorPanel } from '../../../../components/dynamic-app/edit/InspectorPanel'
import { ComponentTreePanel } from '../../../../components/dynamic-app/edit/ComponentTreePanel'
import { CanvasThemeProvider, CanvasThemedContainer, useCanvasThemeOptional } from '../../../../components/dynamic-app/CanvasThemeContext'
import { ProjectTopBar } from '../../../../components/project/ProjectTopBar'
import {
  ChannelsPanel,
  FilesBrowserPanel,
  IDEPanel,
  CapabilitiesPanel,
  MonitorPanel,
  TerminalPanel,
  PlansPanel,
  AgentsPanel,
  CheckpointsPanel,
} from '../../../../components/project/panels'
import { RefreshCw, MessageSquare } from 'lucide-react-native'
import { subagentStreamStore } from '../../../../lib/subagent-stream-store'
import { IntegrationsCard, type TemplateIntegrationRef } from '../../../../components/project/IntegrationsCard'
import { parseToolInstallResult } from '../../../../components/chat/turns/ConnectToolWidget'
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogBody,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog'
import { Heading } from '@/components/ui/heading'
import { Text as UIText } from '@/components/ui/text'
import { Button, ButtonText } from '@/components/ui/button'

type ActiveTab = 'chat' | 'canvas'

const WIDE_BREAKPOINT = 1024
const HIDDEN_HEADER_OPTIONS = { headerShown: false } as const
const STANDALONE_PANELS = ['ide', 'files', 'terminal', 'capabilities', 'channels', 'agents', 'monitor', 'plans', 'checkpoints']

const DEFAULT_CHAT_PANEL_WIDTH = 480
const MIN_CHAT_PANEL_WIDTH = 320
const CHAT_PANEL_WIDTH_STORAGE_KEY = 'shogo:chatPanelWidth'

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

  // Capture initialMessage and files once so they don't re-fire on re-renders.
  // The session ID that should receive these one-time props (only the first tab).
  const [initialPropsSessionId] = useState(() => params.chatSessionId ?? null)
  const [capturedInitialMessage] = useState(() => params.initialMessage ?? undefined)
  const [capturedInitialInteractionMode] = useState<InteractionMode | undefined>(() => {
    const raw = params.initialInteractionMode
    const m = Array.isArray(raw) ? raw[0] : raw
    if (m === 'agent' || m === 'plan' || m === 'ask') return m as InteractionMode
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
    ? getPlanDisplayName(billingData.subscription.planId)
    : 'Free'

  const creditsRemaining =
    billingData.effectiveBalance?.total ??
    getTotalCreditsForPlan(billingData.subscription?.planId)
  const creditsTotal = getCreditsCapacityForDisplay(
    billingData.subscription?.planId,
    billingData.effectiveBalance?.total,
    billingData.effectiveBalance?.monthlyAllocation,
  )

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
      const rawFolders = store?.folderCollection?.all
      return (Array.isArray(rawFolders) ? rawFolders : []).map((f: any) => ({
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
  const [canvasThemeSupported, setCanvasThemeSupported] = useState<boolean | null>(canvasMode === 'json' ? true : null)
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

  const handleCanvasCapabilities = useCallback((caps: { supportsTheme: boolean }) => {
    setCanvasThemeSupported(caps.supportsTheme)
  }, [])

  // Reset theme support detection when the iframe reloads (code-mode only).
  const prevRefreshKeyRef = useRef(iframeRefreshKey)
  useEffect(() => {
    if (canvasMode === 'code' && iframeRefreshKey !== prevRefreshKeyRef.current) {
      prevRefreshKeyRef.current = iframeRefreshKey
      setCanvasThemeSupported(null)
    }
  }, [iframeRefreshKey, canvasMode])

  const allProjects = useMemo(() => {
    try {
      const raw = projects?.all
      const items = Array.isArray(raw) ? raw : []
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
  const { agentUrl: resolvedAgentUrl, previewUrl, canvasBaseUrl } = useAgentUrl(API_URL!, projectId, {
    credentials: Platform.OS === 'web' ? 'include' : 'omit',
    headers: nativeHeaders,
  })

  // When a remote instance is active, route project runtime traffic through
  // the instance tunnel and back into the desktop API's project agent-proxy.
  const { remoteAgentBaseUrl } = useActiveInstance()
  const remoteProjectAgentBaseUrl = useMemo(() => {
    if (!remoteAgentBaseUrl || !projectId) return null
    return `${remoteAgentBaseUrl}/api/projects/${projectId}/agent-proxy`
  }, [remoteAgentBaseUrl, projectId])
  const agentUrl = remoteProjectAgentBaseUrl ?? resolvedAgentUrl

  // APP_MODE_DISABLED: app template copy effect removed

  // Shared model selection — shared between ChatPanel and CapabilitiesPanel
  const hasAdvancedModelAccess = features.billing ? billingData.hasAdvancedModelAccess : true
  const [selectedModel, setSelectedModel] = useState<string>(
    () => hasAdvancedModelAccess ? DEFAULT_MODEL_PRO : DEFAULT_MODEL_FREE
  )

  useEffect(() => {
    loadModelPreference(projectId).then((stored) => {
      if (stored) setSelectedModel(stored)
      else if (hasAdvancedModelAccess) setSelectedModel(DEFAULT_MODEL_PRO)
    })
  }, [hasAdvancedModelAccess, projectId])

  const handleModelChange = useCallback(async (modelId: string) => {
    setSelectedModel(modelId)
    saveModelPreference(modelId, projectId)
    if (agentUrl) {
      const entry = MODEL_CATALOG[modelId as keyof typeof MODEL_CATALOG]
      if (entry) {
        try {
          await agentFetch(`${agentUrl}/agent/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: { provider: entry.provider, name: entry.id } }),
          })
        } catch (err) {
          console.error('[ProjectLayout] Failed to push model config to runtime:', err)
        }
      }
    }
  }, [agentUrl, projectId])

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
  const splitRowRef = useRef<View>(null)

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

  // ─── Open chat tabs state ───────────────────────────────
  const [openChatTabIds, setOpenChatTabIds] = useState<string[]>([])
  /** Web: pending delete confirmation (AlertDialog); native uses Alert.alert */
  const [deleteChatConfirmSessionId, setDeleteChatConfirmSessionId] = useState<string | null>(null)
  const openTabsRestoredRef = useRef(false)

  // Restore open tabs from AsyncStorage on mount
  useEffect(() => {
    if (!projectId || openTabsRestoredRef.current) return
    AsyncStorage.getItem(`shogo:chatTabs:${projectId}`).then((raw) => {
      if (raw) {
        try {
          const ids = JSON.parse(raw)
          if (Array.isArray(ids) && ids.length > 0) {
            setOpenChatTabIds(ids)
            openTabsRestoredRef.current = true
            return
          }
        } catch { /* ignore malformed data */ }
      }
      openTabsRestoredRef.current = true
    }).catch(() => { openTabsRestoredRef.current = true })
  }, [projectId])

  // Persist open tabs to AsyncStorage when they change
  useEffect(() => {
    if (!projectId || !openTabsRestoredRef.current || openChatTabIds.length === 0) return
    AsyncStorage.setItem(`shogo:chatTabs:${projectId}`, JSON.stringify(openChatTabIds)).catch(() => {})
  }, [projectId, openChatTabIds])

  // Ensure the active session is always in the open tabs list
  useEffect(() => {
    if (!chatSessionId) return
    setOpenChatTabIds((prev) => {
      if (prev.includes(chatSessionId)) return prev
      return [...prev, chatSessionId]
    })
  }, [chatSessionId])

  const handleCloseTab = useCallback((tabId: string) => {
    streamingChangeHandlersRef.current.delete(tabId)
    setStreamingTabIds((prev) => {
      if (!prev.has(tabId)) return prev
      const next = new Set(prev)
      next.delete(tabId)
      return next
    })
    setOpenChatTabIds((prev) => {
      const next = prev.filter((id) => id !== tabId)
      if (tabId === chatSessionId) {
        const idx = prev.indexOf(tabId)
        const neighbor = prev[idx + 1] ?? prev[idx - 1]
        if (neighbor) {
          setChatSessionId(neighbor)
        } else {
          setChatSessionId(null)
        }
      }
      if (next.length === 0 && projectId) {
        AsyncStorage.removeItem(`shogo:chatTabs:${projectId}`).catch(() => {})
      }
      return next
    })
  }, [chatSessionId, projectId])

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
            inferredName: 'Untitled',
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
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)
  const [previewTab, setPreviewTab] = useState('dynamic-app')

  // Resizable chat panel width (wide split mode only)
  const [chatPanelWidth, setChatPanelWidth] = useState(DEFAULT_CHAT_PANEL_WIDTH)
  const maxChatPanelWidth = Math.floor(width * 0.5)
  const clampChatWidth = useCallback((w: number) =>
    Math.max(MIN_CHAT_PANEL_WIDTH, Math.min(w, Math.floor(width * 0.5))),
    [width],
  )

  useEffect(() => {
    AsyncStorage.getItem(CHAT_PANEL_WIDTH_STORAGE_KEY).then((raw) => {
      if (raw) {
        const parsed = parseInt(raw, 10)
        if (!isNaN(parsed) && parsed > 0) setChatPanelWidth(parsed)
      }
    }).catch(() => {})
  }, [])

  const persistChatPanelWidth = useCallback((w: number) => {
    setChatPanelWidth(w)
    AsyncStorage.setItem(CHAT_PANEL_WIDTH_STORAGE_KEY, String(w)).catch(() => {})
  }, [])

  const PERSISTABLE_PREVIEW_TABS = useMemo(() => new Set(['dynamic-app', 'chat-fullscreen', 'app-preview']), [])

  useEffect(() => {
    if (!projectId) return
    AsyncStorage.getItem(`shogo:lastPreviewTab:${projectId}`).then((saved) => {
      if (saved) setPreviewTab(saved)
    }).catch(() => {})
  }, [projectId])

  useEffect(() => {
    if (projectId && previewTab && PERSISTABLE_PREVIEW_TABS.has(previewTab)) {
      AsyncStorage.setItem(`shogo:lastPreviewTab:${projectId}`, previewTab).catch(() => {})
    }
  }, [projectId, previewTab, PERSISTABLE_PREVIEW_TABS])

  const [chatMessages, setChatMessages] = useState<any[]>([])
  const [streamingTabIds, setStreamingTabIds] = useState<Set<string>>(new Set())
  const handleTabStreamingChange = useCallback((tabId: string, isStreaming: boolean) => {
    setStreamingTabIds((prev) => {
      const has = prev.has(tabId)
      if (isStreaming && has) return prev
      if (!isStreaming && !has) return prev
      const next = new Set(prev)
      if (isStreaming) next.add(tabId)
      else next.delete(tabId)
      return next
    })
  }, [])
  const streamingChangeHandlersRef = useRef<Map<string, (streaming: boolean) => void>>(new Map())
  const getStreamingChangeHandler = useCallback((tabId: string) => {
    let handler = streamingChangeHandlersRef.current.get(tabId)
    if (!handler) {
      handler = (streaming: boolean) => handleTabStreamingChange(tabId, streaming)
      streamingChangeHandlersRef.current.set(tabId, handler)
    }
    return handler
  }, [handleTabStreamingChange])
  const [buildPlanRequest, setBuildPlanRequest] = useState<{ plan: any; modelId: string; nonce: number } | null>(null)
  const [selectedAgentToolId, setSelectedAgentToolId] = useState<string | null>(null)

  useEffect(() => {
    if (!canvasEnabled) {
      if (
        activeTab === 'canvas' &&
        previewTab !== 'app-preview' &&
        !STANDALONE_PANELS.includes(previewTab)
      ) {
        setActiveTab('chat')
      }
    } else if (canvasEnabled) {
      if (previewTab === 'app-preview') setPreviewTab('dynamic-app')
    }
  }, [canvasEnabled, activeMode, previewTab, activeTab])

  // Narrow + Android: back from Capabilities → chat column, with Canvas preview selected when canvas is on.
  useEffect(() => {
    if (Platform.OS !== 'android' || isWide) return

    const onBack = () => {
      if (previewTab !== 'capabilities') return false
      setActiveTab('chat')
      setPreviewTab('chat-fullscreen')
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

  const techStackId = projectSettings.techStackId as string | undefined

  const handleTechStackChange = useCallback(async (stackId: string, capabilities?: Record<string, boolean>) => {
    const patch: Record<string, unknown> = { techStackId: stackId }
    if (capabilities) Object.assign(patch, capabilities)
    await updateProjectSettings(patch)

    if (capabilities && agentUrl) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (nativeHeaders) Object.assign(headers, nativeHeaders())
        await fetch(`${agentUrl}/agent/config`, {
          method: 'PATCH',
          headers,
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          body: JSON.stringify(capabilities),
        })
      } catch (err) {
        console.error('[ProjectLayout] Failed to push stack capabilities to runtime:', err)
      }
    }
  }, [updateProjectSettings, agentUrl, nativeHeaders])

  const handleBuildPlan = useCallback((plan: any, modelId: string) => {
    setBuildPlanRequest({ plan, modelId, nonce: Date.now() })
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
            // Per-session collection so concurrent loadAll calls don't clobber
            // each other (and don't clobber an active ChatPanel's messages).
            const sessionMessages = getChatMessageCollectionForSession(s.id)
            await sessionMessages.loadAll({ sessionId: s.id })
            const msgs = sessionMessages.all
              .filter((m: any) => m.role === 'user')
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

  // Read name/inferredName from each session so MobX observer tracks those
  // fields. The .all getter is reference-stable for field-only updates (no
  // map-structure change), so useMemo wouldn't recompute without this.
  let _sessionNameKey = ''
  if (store?.chatSessionCollection) {
    for (const s of store.chatSessionCollection.all as any[]) {
      if (s.contextId === projectId) _sessionNameKey += s.name + '\0' + s.inferredName + '\n'
    }
  }

  const chatSessions: ChatSession[] = useMemo(() => {
    if (!store?.chatSessionCollection) return []
    try {
      const sessionsAll = Array.isArray(store.chatSessionCollection.all) ? store.chatSessionCollection.all : []
      return sessionsAll
        .filter((s: any) => s.contextId === projectId)
        .map((s: any) => ({
          id: s.id,
          name:
            (typeof s.name === 'string' && s.name.trim())
              ? s.name.trim()
              : sessionNames[s.id] ||
                s.inferredName ||
                `Chat · ${new Date(s.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
          messageCount: -1,
          updatedAt: s.lastActiveAt || s.updatedAt || s.createdAt || Date.now(),
        }))
        .sort((a: ChatSession, b: ChatSession) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store?.chatSessionCollection?.all, sessionNames, projectId, _sessionNameKey])

  // Build ordered tab list with display names from openChatTabIds
  const openChatTabs: ChatTab[] = useMemo(() => {
    const sessionMap = new Map(chatSessions.map((s) => [s.id, s.name]))
    return openChatTabIds
      .map((id) => ({ id, name: sessionMap.get(id) || 'Untitled' }))
  }, [openChatTabIds, chatSessions])

  const handleSelectTab = useCallback((tabId: string) => {
    setChatSessionId(tabId)
  }, [])

  const handleCreateNewSession = useCallback(async () => {
    try {
      const newSession = await actions.createChatSession({
        inferredName: 'Untitled',
        contextType: 'project',
        contextId: projectId!,
      })
      if (newSession?.id) {
        setOpenChatTabIds((prev) => prev.includes(newSession.id) ? prev : [...prev, newSession.id])
        setChatSessionId(newSession.id)
      }
    } catch (err) {
      console.error('[ProjectLayout] Failed to create chat session:', err)
    }
  }, [actions, projectId])

  const handleRenameChatSession = useCallback(
    async (sessionId: string, newName: string) => {
      try {
        await actions.updateChatSession(sessionId, { name: newName })
        // Flush into the local sessionNames cache so the useMemo dep changes
        // and chatSessions / openChatTabs recompute immediately.
        setSessionNames((prev) => ({ ...prev, [sessionId]: newName }))
      } catch (err) {
        console.error('[ProjectLayout] Failed to rename chat session:', err)
      }
    },
    [actions],
  )

  const performDeleteChatSession = useCallback(
    async (sessionId: string) => {
      try {
        await actions.deleteChatSession(sessionId)
        handleCloseTab(sessionId)
      } catch (err) {
        console.error('[ProjectLayout] Failed to delete chat session:', err)
      }
    },
    [actions, handleCloseTab],
  )

  const handleDeleteChatSession = useCallback(
    (sessionId: string) => {
      const confirmMsg = 'Delete this chat? This cannot be undone.'
      if (Platform.OS === 'web') {
        setDeleteChatConfirmSessionId(sessionId)
      } else {
        Alert.alert('Delete chat', confirmMsg, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => { void performDeleteChatSession(sessionId) } },
        ])
      }
    },
    [performDeleteChatSession],
  )

  const handleConfirmDeleteChatDialog = useCallback(() => {
    if (!deleteChatConfirmSessionId) return
    const id = deleteChatConfirmSessionId
    setDeleteChatConfirmSessionId(null)
    void performDeleteChatSession(id)
  }, [deleteChatConfirmSessionId, performDeleteChatSession])

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

  // Memoized billingData fallback — must be declared before any conditional
  // return so hook order stays stable across the loading → loaded transition.
  //
  // IMPORTANT: `useBillingData()` returns a fresh object on every render, so
  // memoizing on the whole `billingData` reference would still produce a new
  // `billingDataResolved` every render and break observer()/memo equality in
  // every mounted ChatPanel (the root cause of tab-switch + streaming jank).
  // Depend on the primitive fields ChatPanel actually consumes instead. The
  // `refetchCreditLedger` callback is wrapped in useCallback([]) inside the
  // hook, so its identity is already stable across renders.
  const billingHasActive = features.billing ? billingData.hasActiveSubscription : true
  const billingHasAdvanced = features.billing ? billingData.hasAdvancedModelAccess : true
  const billingRefetch = billingData.refetchCreditLedger
  const billingDataResolved = useMemo(
    () => ({
      hasActiveSubscription: billingHasActive,
      hasAdvancedModelAccess: billingHasAdvanced,
      refetchCreditLedger: billingRefetch,
    }),
    [billingHasActive, billingHasAdvanced, billingRefetch],
  )

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

  const chatPanels = (
    <>
      {openChatTabIds.map((tabId) => {
        const isActive = tabId === chatSessionId
        const isInitialSession = tabId === initialPropsSessionId
        return (
          <View
            key={tabId}
            className="flex-1"
            style={!isActive ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0 } : undefined}
            pointerEvents={isActive ? 'auto' : 'none'}
          >
            <ChatPanel
              featureId={projectId ?? null}
              featureName={project.name}
              phase={null}
              chatSessionId={tabId}
              onChatSessionChange={handleChatSessionChange}
              workspaceId={project?.workspaceId}
              userId={user?.id}
              projectId={projectId}
              projectType="unified"
              isActive={isActive}
              localAgentUrl={remoteProjectAgentBaseUrl ?? undefined}
              initialMessage={isInitialSession ? capturedInitialMessage : undefined}
              initialInteractionMode={isInitialSession ? capturedInitialInteractionMode : undefined}
              initialFiles={isInitialSession ? capturedInitialFiles : undefined}
              billingData={billingDataResolved}
              onCanvasPreview={handleCanvasPreview}
              onMessagesChange={isActive ? setChatMessages : undefined}
              onStreamingChange={getStreamingChangeHandler(tabId)}
              buildPlanRequest={isActive ? buildPlanRequest : null}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
              className="flex-1"
            />
          </View>
        )
      })}
    </>
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
      onCanvasCapabilities={handleCanvasCapabilities}
    />
  ) : null

  const hiddenTabs: string[] = ['app-preview'] // APP_MODE_DISABLED: always hide app-preview
  if (activeMode !== 'canvas') hiddenTabs.push('dynamic-app')

  const isChatFullscreen = isWide && previewTab === 'chat-fullscreen'

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
    chatPanelWidth: clampChatWidth(chatPanelWidth),
    chatFullscreenSidebarWidth: isChatFullscreen ? 280 : undefined,
    onSearchChats: isChatFullscreen ? () => setSidebarSearchOpen(true) : undefined,
    onNewChat: isChatFullscreen ? handleCreateNewSession : undefined,
    onRenameChat: isChatFullscreen ? handleRenameChatSession : undefined,
    onDeleteChat: isChatFullscreen ? handleDeleteChatSession : undefined,
    activeChatSessionId: isChatFullscreen ? chatSessionId : undefined,
    activeChatSessionName: isChatFullscreen ? (openChatTabs.find(t => t.id === chatSessionId)?.name ?? null) : undefined,
    canvasActive: canvasEnabled && previewTab === 'dynamic-app',
    canvasThemeSupported,
    effectiveSurfaceId,
    onCanvasRefresh: canvasMode === 'code' ? () => setIframeRefreshKey(k => k + 1) : undefined,
  }

  return (
    <>
      <Stack.Screen options={HIDDEN_HEADER_OPTIONS} />

      <PlanStreamProvider>
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
                    setPreviewTab('chat-fullscreen')
                  }
                }}
                onTabChange={(tabId: string) => {
                  handlePreviewTabChange(tabId)
                  if (tabId !== 'dynamic-app' && tabId !== 'app-preview' && tabId !== 'chat-fullscreen') setActiveTab('canvas')
                }}
              />
            )}

            {/* Content — chat panel stays mounted across layout/tab changes */}
            <View className={cn('flex-1', isWide && 'flex-row')} ref={splitRowRef}>
              {/* Chat column — single mount point so ChatPanel never unmounts on mode switch */}
              <View
                className={cn(
                  'flex min-h-0 flex-col',
                  isChatFullscreen
                    ? 'flex-1 flex-row'
                    : isWide
                      ? 'shrink-0 bg-background z-10'
                      : 'relative flex-1',
                  !isChatFullscreen && chatHidden && 'hidden',
                )}
                style={!isChatFullscreen && isWide && !chatHidden ? { width: clampChatWidth(chatPanelWidth) } : undefined}
              >
                {isChatFullscreen && (
                  <View className="w-[280px] bg-muted/50 dark:bg-black/30">
                    <ChatSessionSidebar
                      sessions={chatSessions}
                      currentSessionId={chatSessionId ?? undefined}
                      onSelect={(sessionId) => {
                        setOpenChatTabIds((prev) => prev.includes(sessionId) ? prev : [...prev, sessionId])
                        setChatSessionId(sessionId)
                      }}
                      onCreate={handleCreateNewSession}
                      onLoadMore={handleLoadMoreSessions}
                      hasMore={store?.chatSessionCollection?.hasMore ?? false}
                      isLoadingMore={store?.chatSessionCollection?.isLoadingMore ?? false}
                      hideHeader
                      searchOpen={sidebarSearchOpen}
                      onSearchClose={() => setSidebarSearchOpen(false)}
                    />
                  </View>
                )}
                {!isChatFullscreen && isWide && showChatSessions && (
                  <View className="shrink-0 border-b border-border bg-background">
                    <ChatSessionPicker
                      sessions={chatSessions}
                      currentSessionId={chatSessionId ?? undefined}
                      onSelect={(sessionId) => {
                        setOpenChatTabIds((prev) => prev.includes(sessionId) ? prev : [...prev, sessionId])
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
                {isChatFullscreen ? (
                  <View className="min-h-0 flex-1 flex-col">
                    <View className="min-h-0 flex-1">{chatPanels}</View>
                  </View>
                ) : (
                  <>
                    {isWide && (
                      <ChatTabBar
                        tabs={openChatTabs}
                        activeTabId={chatSessionId}
                        onSelectTab={handleSelectTab}
                        onCloseTab={handleCloseTab}
                        onNewChat={handleCreateNewSession}
                        onHistoryToggle={() => setShowChatSessions((s: boolean) => !s)}
                        showHistory={showChatSessions}
                        streamingTabIds={streamingTabIds}
                        onRenameSession={handleRenameChatSession}
                        onDeleteSession={handleDeleteChatSession}
                      />
                    )}
                    <View className="min-h-0 flex-1">{chatPanels}</View>
                  </>
                )}
              </View>

              {/* Drag handle to resize chat panel (web only, wide split mode) */}
              {Platform.OS === 'web' && isWide && !isChatFullscreen && !chatHidden && (
                <ChatPanelResizeHandle
                  splitRowRef={splitRowRef}
                  chatPanelWidth={clampChatWidth(chatPanelWidth)}
                  minWidth={MIN_CHAT_PANEL_WIDTH}
                  maxWidth={maxChatPanelWidth}
                  onResize={setChatPanelWidth}
                  onResizeEnd={persistChatPanelWidth}
                  defaultWidth={DEFAULT_CHAT_PANEL_WIDTH}
                />
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
                    setPreviewTab('chat-fullscreen')
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
              <IDEPanel visible={previewTab === 'ide'} projectId={projectId!} projectName={project.name} agentUrl={agentUrl} />
              <FilesBrowserPanel visible={previewTab === 'files'} projectId={projectId!} agentUrl={agentUrl} />
              <TerminalPanel visible={previewTab === 'terminal'} messages={chatMessages} />
              <CapabilitiesPanel visible={previewTab === 'capabilities'} projectId={projectId!} agentUrl={agentUrl} capabilities={capabilitySettings} onCapabilityToggle={handleCapabilityToggle} isPaidPlan={effectiveHasActiveSubscription} activeMode={activeMode} onModeChange={handleManualModeChange} techStackId={techStackId} onTechStackChange={handleTechStackChange} selectedModel={selectedModel} onModelChange={handleModelChange} />
              <ChannelsPanel visible={previewTab === 'channels'} projectId={projectId!} agentUrl={agentUrl} hasAdvancedModelAccess={features.billing ? billingData.hasAdvancedModelAccess : true} />
              <AgentsPanel visible={previewTab === 'agents'} selectedToolId={selectedAgentToolId} agentUrl={agentUrl} />
              <MonitorPanel visible={previewTab === 'monitor'} projectId={projectId!} agentUrl={agentUrl} isPaidPlan={effectiveHasActiveSubscription} />
              <PlansPanel visible={previewTab === 'plans'} projectId={projectId!} agentUrl={agentUrl} onBuildPlan={handleBuildPlan} />
              <CheckpointsPanel visible={previewTab === 'checkpoints'} projectId={projectId!} />
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

      {Platform.OS === 'web' && (
        <AlertDialog
          isOpen={deleteChatConfirmSessionId !== null}
          onClose={() => setDeleteChatConfirmSessionId(null)}
          size="sm"
        >
          <AlertDialogBackdrop />
          <AlertDialogContent>
            <AlertDialogHeader>
              <Heading size="md" className="text-typography-950">
                Delete chat
              </Heading>
            </AlertDialogHeader>
            <AlertDialogBody className="mt-3 mb-4">
              <UIText size="sm" className="text-typography-700">
                Delete this chat? This cannot be undone.
              </UIText>
            </AlertDialogBody>
            <AlertDialogFooter>
              <Button
                variant="outline"
                action="secondary"
                onPress={() => setDeleteChatConfirmSessionId(null)}
              >
                <ButtonText>Cancel</ButtonText>
              </Button>
              <Button action="negative" onPress={handleConfirmDeleteChatDialog}>
                <ButtonText>Delete</ButtonText>
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </PlanStreamProvider>
    </>
  )
})

// ---------------------------------------------------------------------------
// ChatPanelResizeHandle — web-only drag handle between chat column and canvas
// ---------------------------------------------------------------------------

function ChatPanelResizeHandle({
  splitRowRef,
  chatPanelWidth,
  minWidth,
  maxWidth,
  onResize,
  onResizeEnd,
  defaultWidth,
}: {
  splitRowRef: React.RefObject<View | null>
  chatPanelWidth: number
  minWidth: number
  maxWidth: number
  onResize: (w: number) => void
  onResizeEnd: (w: number) => void
  defaultWidth: number
}) {
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const latestWidthRef = useRef(chatPanelWidth)

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    setDragging(true)

    const container = splitRowRef.current as unknown as HTMLElement | null
    if (!container) return
    const containerRect = container.getBoundingClientRect()

    const onPointerMove = (ev: PointerEvent) => {
      const newWidth = Math.max(minWidth, Math.min(maxWidth, ev.clientX - containerRect.left))
      latestWidthRef.current = newWidth
      onResize(newWidth)
    }

    const onPointerUp = () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setDragging(false)
      onResizeEnd(latestWidthRef.current)
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
  }, [splitRowRef, minWidth, maxWidth, onResize, onResizeEnd])

  const handleDoubleClick = useCallback(() => {
    onResizeEnd(defaultWidth)
  }, [defaultWidth, onResizeEnd])

  const active = dragging || hovered

  return (
    <View
      // @ts-expect-error web-only event handlers
      onPointerDown={handlePointerDown}
      onDoubleClick={handleDoubleClick}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className="shrink-0 items-center justify-center"
      style={{
        width: 5,
        cursor: 'col-resize' as any,
        zIndex: 20,
      }}
    >
      <View
        className={cn(
          'h-full transition-all duration-150',
          active ? 'bg-primary/40' : 'bg-transparent',
        )}
        style={{ width: active ? 3 : 1 }}
      />
    </View>
  )
}

// ---------------------------------------------------------------------------
// TopBarBridge — reads EditModeContext and passes values to ProjectTopBar
// ---------------------------------------------------------------------------

function TopBarBridge({
  canvasActive,
  canvasThemeSupported,
  effectiveSurfaceId,
  surfaceEntries,
  ...props
}: React.ComponentProps<typeof ProjectTopBar> & {
  canvasActive: boolean
  canvasThemeSupported: boolean | null
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
        canvasThemeSupported={canvasThemeSupported}
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
  onCanvasCapabilities,
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
  onCanvasCapabilities?: (caps: { supportsTheme: boolean }) => void
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
        <CanvasWebView agentUrl={agentUrl} canvasBaseUrl={readyCanvasBaseUrl} activeSurfaceId={activeSurfaceId} refreshKey={iframeRefreshKey} onCanvasCapabilities={onCanvasCapabilities} />
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
