// SPDX-License-Identifier: MIT
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
import type { IDomainStore } from '@shogo/domain-stores'
import { cn } from '@shogo/shared-ui/primitives'
import { useAgentUrl, useBillingData } from '@shogo/shared-app/hooks'
import {
  getIncludedUsdForPlan,
  getIncludedUsdCapacityForDisplay,
  getPlanDisplayName,
} from '../../../../lib/billing-config'
import { useAuth } from '../../../../contexts/auth'
import { useDomainHttp } from '../../../../contexts/domain'
import { authClient } from '../../../../lib/auth-client'
import { API_URL, api } from '../../../../lib/api'
import { workspaceProjectFilter } from '../../../../lib/project-load'
import { getActiveWorkspaceId } from '../../../../lib/workspace-store'
import { usePlatformConfig } from '../../../../lib/platform-config'
import { consumePendingFiles } from '../../../../lib/pending-image-store'
import { isNativePhoneIntegrationsLayout } from '../../../../lib/native-phone-layout'
import { ChatPanel } from '../../../../components/chat/ChatPanel'
import { PlanStreamProvider } from '../../../../components/chat/PlanStreamContext'
import {
  ChatBridgeProvider,
  useChatBridge,
} from '../../../../components/voice-mode/ChatBridgeContext'
import { EzModeChatPanel } from '../../../../components/voice-mode/EzModeChatPanel'
import type { InteractionMode } from '../../../../components/chat/ChatInput'
import { DEFAULT_MODEL_PRO, DEFAULT_MODEL_FREE } from '../../../../components/chat/ChatInput'
import { loadModelPreference, saveModelPreference } from '../../../../lib/agent-mode-preference'
import { MODEL_CATALOG } from '@shogo/model-catalog'
import { agentFetch } from '../../../../lib/agent-fetch'
import { useActiveInstance } from '../../../../contexts/active-instance'
import { ChatSessionSidebar, type ChatSession } from '../../../../components/chat/ChatSessionPicker'
import { CanvasWebView } from '../../../../components/canvas/CanvasWebView'
import { ExternalPreviewWebView } from '../../../../components/canvas/ExternalPreviewWebView'
import { ProjectTopBar } from '../../../../components/project/ProjectTopBar'
import { PanelErrorBoundary } from '../../../../components/project/panels/PanelErrorBoundary'
import {
  ChannelsPanel,
  FilesBrowserPanel,
  IDEPanel,
  CapabilitiesPanel,
  MonitorPanel,
  PlansPanel,
  AgentsPanel,
  CheckpointsPanel,
} from '../../../../components/project/panels'
import { FoldersPanel } from '../../../../components/project/panels/FoldersPanel'
import { TrustPrompt, type TrustDecision } from '../../../../components/project/TrustPrompt'
import { DrawerHost } from '../../../../components/project/panels/ide/DrawerHost'
import { RefreshCw, MessageSquare, Sparkles, Bug, X as XIcon } from 'lucide-react-native'
import {
  useToast,
  Toast,
  ToastTitle,
  ToastDescription,
} from '../../../../components/ui/toast'
import { getEntries as getRuntimeLogEntries } from '../../../../lib/runtime-logs/runtime-log-store'
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
// `terminal` is intentionally absent — chat exec entries now appear in
// the IDE bottom drawer's "Output" tab (filterable to "Exec").
const STANDALONE_PANELS = ['ide', 'files', 'capabilities', 'channels', 'agents', 'monitor', 'plans', 'checkpoints', 'folders', 'external-preview']

const DEFAULT_CHAT_PANEL_WIDTH = 480
const MIN_CHAT_PANEL_WIDTH = 320
const CHAT_PANEL_WIDTH_STORAGE_KEY = 'shogo:chatPanelWidth'

/** Suppress duplicate "[canvas-error]" toasts within this many ms. */
const CANVAS_ERROR_DEDUP_MS = 10_000
/** How many recent runtime log entries to attach to a debug-with-EZ-Mode prompt. */
const CANVAS_ERROR_LOG_TAIL = 30
/** Cap any single error / log line so the seed prompt stays bounded. */
const CANVAS_ERROR_MAX_LINE = 1200

/**
 * Build the seed message that gets auto-sent into a fresh chat when the
 * user clicks "Debug" on a `[canvas-error]` toast.
 *
 * The prompt deliberately includes everything the agent would otherwise
 * have to hunt down: the iframe's current page, the phase (compile vs
 * runtime), the full error string, the breadcrumb of recent user actions
 * (clicks / navigations / form submits) leading up to the crash, and the
 * tail of the runtime log buffer (build output / console lines).
 *
 * The surface label is only included when the canvas actually exposes a
 * Shogo surface — workspace canvases (Vite/Expo apps with their own
 * router) don't, and the page route is the meaningful identifier there.
 */
function buildCanvasErrorDebugPrompt(args: {
  surfaceId: string
  surfaceTitle?: string | null
  phase: 'compile' | 'runtime'
  error: string
  /** Iframe `pathname + search + hash` at the moment of the error. */
  route?: string
  /** Recent user-interaction breadcrumb from `canvas-bridge.js`, oldest first. */
  recentActions?: ReadonlyArray<{
    ts: number
    kind: string
    target?: string
    route?: string
  }>
  recentLogs: ReadonlyArray<{
    source: string
    level: string
    text: string
    ts: number
  }>
}): string {
  const { surfaceId, surfaceTitle, phase, error, route, recentActions, recentLogs } = args
  const truncate = (s: string, n: number) =>
    s.length <= n ? s : `${s.slice(0, n - 1)}…`
  const phaseLabel = phase === 'compile' ? 'compile-time' : 'runtime'
  // Only call out the surface when one is actually known — for plain
  // workspace canvases `surfaceId` is empty/`undefined` and the old
  // wording ("on `undefined`") was actively confusing.
  const hasSurface = !!surfaceTitle || (!!surfaceId && surfaceId !== 'undefined')
  const surfaceLabel = surfaceTitle
    ? ` on \`${surfaceTitle}\``
    : hasSurface
      ? ` on \`${surfaceId}\``
      : ''
  const pageLabel = route ? ` (page \`${route}\`)` : ''

  const lines: string[] = []
  lines.push(
    `🐞 The canvas just hit a ${phaseLabel} error${surfaceLabel}${pageLabel}. Please diagnose the root cause and propose / apply a minimal fix.`,
  )
  lines.push('')
  lines.push('**Error**')
  lines.push('```')
  lines.push(truncate(error, CANVAS_ERROR_MAX_LINE))
  lines.push('```')

  if (recentActions && recentActions.length > 0) {
    lines.push('')
    lines.push(
      `**Recent user actions** (last ${recentActions.length}, oldest first — most recent immediately before the error)`,
    )
    lines.push('```')
    for (const a of recentActions) {
      const ts = Number.isFinite(a.ts) ? new Date(a.ts).toISOString().slice(11, 23) : '--:--:--.---'
      const target = a.target ? ` ${a.target}` : ''
      const onPage = a.route && a.route !== route ? ` @ ${a.route}` : ''
      lines.push(truncate(`${ts} ${a.kind}${target}${onPage}`, CANVAS_ERROR_MAX_LINE))
    }
    lines.push('```')
  }

  if (recentLogs.length > 0) {
    lines.push('')
    lines.push(`**Recent runtime logs** (last ${recentLogs.length}, oldest first)`)
    lines.push('```')
    for (const e of recentLogs) {
      const ts = new Date(e.ts).toISOString().slice(11, 23)
      lines.push(
        `${ts} [${e.source}] ${e.level !== 'info' ? `${e.level.toUpperCase()} ` : ''}${truncate(e.text, CANVAS_ERROR_MAX_LINE)}`,
      )
    }
    lines.push('```')
  }

  lines.push('')
  lines.push(
    'Read the relevant files, identify the offending change, and either propose a fix or apply it directly. Keep the change minimal and explain what went wrong.',
  )
  return lines.join('\n')
}

export default observer(function ProjectLayout() {
  const params = useLocalSearchParams<{
    id: string
    chatSessionId?: string
    initialMessage?: string
    initialInteractionMode?: string
    appTemplateName?: string
    showIntegrations?: string
    /** When '1', enter EZ Mode immediately on mount (homepage mic flow). */
    startEzMode?: string
    /** When '1' alongside `startEzMode`, auto-connect the voice session once. */
    autoStartVoice?: string
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
  const toast = useToast()

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
  // Capture once so router param changes don't re-fire EZ Mode.
  const [capturedStartEzMode] = useState(() => params.startEzMode === '1')
  const [capturedAutoStartVoice] = useState(() => params.autoStartVoice === '1')

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

  const subSeats = billingData.subscription?.seats ?? 1
  const usdRemaining =
    billingData.effectiveBalance?.total ??
    getIncludedUsdForPlan(billingData.subscription?.planId, subSeats)
  const usdTotal = getIncludedUsdCapacityForDisplay({
    planId: billingData.subscription?.planId,
    seats: subSeats,
    remainingTotal: billingData.effectiveBalance?.total,
    monthlyIncludedAllocationUsd: billingData.effectiveBalance?.monthlyIncludedAllocationUsd,
  })

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
  const [iframeRefreshKey, setIframeRefreshKey] = useState(0)
  const [canvasThemeSupported, setCanvasThemeSupported] = useState<boolean | null>(null)
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
    sdkGuideEnabled: projectSettings.sdkGuideEnabled !== false,
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

  // ── External preview (folder-linked / `workingMode === 'external'`) ─
  //
  // For Open-Folder projects we expose a desktop-only Electron
  // WebContentsView that loads the user's own dev server (Vite/Next/etc).
  // The URL comes from two sources:
  //   1. Auto-detection: agent-runtime sniffs `Local: http://...` lines
  //      from any PTY session and surfaces the most recent via
  //      /preview/detected-urls.
  //   2. Manual: user typed into the address bar; persisted on
  //      Project.settings.externalPreview.savedUrl via the
  //      /api/projects/:id/external-preview endpoints.
  //
  // We keep both in state here so the address-bar and the empty-state
  // chip can both surface the detected URL even when nothing is saved.
  const isExternalProject = (project?.workingMode ?? 'managed') === 'external'
  const projectTrustLevel: 'restricted' | 'trusted' = project?.trustLevel === 'trusted' ? 'trusted' : 'restricted'
  const primaryFolderPath = useMemo<string | null>(() => {
    const folders = (project?.projectFolders ?? []) as Array<{ path: string; isPrimary?: boolean }>
    const primary = folders.find((f) => f.isPrimary) ?? folders[0]
    return primary?.path ?? null
  }, [project?.projectFolders])
  const [externalSavedUrl, setExternalSavedUrl] = useState<string | null>(null)
  const [externalDetectedUrl, setExternalDetectedUrl] = useState<string | null>(null)
  const [trustPromptOpen, setTrustPromptOpen] = useState(false)
  const [trustSubmitting, setTrustSubmitting] = useState(false)
  const trustAutoShownRef = useRef(false)

  // Pull the saved/detected URL pair when the project resolves as
  // external. We re-fetch on `agentUrl` change because the detected URL
  // routes through the agent-runtime — once the pod URL changes, we may
  // discover a new fresher detection.
  useEffect(() => {
    if (!projectId || !isExternalProject) return
    let cancelled = false
    const fetchState = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/projects/${encodeURIComponent(projectId)}/external-preview`,
          { credentials: Platform.OS === 'web' ? 'include' : 'omit' },
        )
        if (!res.ok) return
        const body = await res.json()
        if (cancelled) return
        if (typeof body?.savedUrl === 'string') setExternalSavedUrl(body.savedUrl)
        else setExternalSavedUrl(null)
        if (typeof body?.detectedUrl === 'string') setExternalDetectedUrl(body.detectedUrl)
      } catch (err) {
        if (!cancelled) console.warn('[external-preview] fetch failed:', err)
      }
    }
    void fetchState()
    // Poll modestly while the user is on the project page — the SSE
    // detected-urls stream lives on the agent-runtime and isn't yet
    // proxied through the API; a 5 s poll is fine until we wire that.
    const t = setInterval(fetchState, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [projectId, isExternalProject])

  const handleSaveExternalPreviewUrl = useCallback(async (url: string) => {
    if (!projectId) return
    try {
      const res = await fetch(
        `${API_URL}/api/projects/${encodeURIComponent(projectId)}/external-preview`,
        {
          method: 'PUT',
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ savedUrl: url }),
        },
      )
      if (res.status === 403) {
        const body = await res.json().catch(() => ({}))
        if (body?.needsTrust) {
          // Non-local URL on a restricted project → nudge the user to
          // trust the workspace. The URL isn't saved; once they trust
          // and retry, the same handler will persist it.
          setTrustPromptOpen(true)
          return
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        Alert.alert('Could not set preview URL', String(body?.error ?? `HTTP ${res.status}`))
        return
      }
      const body = await res.json().catch(() => ({}))
      if (typeof body?.savedUrl === 'string') setExternalSavedUrl(body.savedUrl)
    } catch (err: any) {
      Alert.alert('Could not set preview URL', err?.message ?? String(err))
    }
  }, [projectId])

  const handleTrustDecision = useCallback(async (decision: TrustDecision) => {
    if (!projectId) return
    setTrustSubmitting(true)
    try {
      // "restricted" → just close; the agent-runtime keeps blocking
      // writes/exec server-side regardless.
      if (decision === 'restricted') {
        setTrustPromptOpen(false)
        return
      }
      const res = await fetch(
        `${API_URL}/api/local/projects/${encodeURIComponent(projectId)}/trust`,
        {
          method: 'POST',
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trusted: true }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        Alert.alert('Could not update trust', String(body?.error ?? `HTTP ${res.status}`))
        return
      }
      const body = await res.json().catch(() => ({}))
      if (body?.project) setProject(body.project)
      setTrustPromptOpen(false)
    } catch (err: any) {
      Alert.alert('Could not update trust', err?.message ?? String(err))
    } finally {
      setTrustSubmitting(false)
    }
  }, [projectId])

  // Auto-show the trust prompt the first time an external + restricted
  // project lands on this layout. We track this with a ref so the modal
  // doesn't re-pop after the user has dismissed it once per session.
  useEffect(() => {
    if (!isExternalProject) return
    if (projectTrustLevel !== 'restricted') return
    if (trustAutoShownRef.current) return
    trustAutoShownRef.current = true
    setTrustPromptOpen(true)
  }, [isExternalProject, projectTrustLevel])

  // Reset theme support detection when the iframe reloads (code-mode only).
  const prevRefreshKeyRef = useRef(iframeRefreshKey)
  useEffect(() => {
    if (iframeRefreshKey !== prevRefreshKeyRef.current) {
      prevRefreshKeyRef.current = iframeRefreshKey
      setCanvasThemeSupported(null)
    }
  }, [iframeRefreshKey])

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

  // Resolve agent + preview URLs.
  //
  // `runtimeReady` is held false until `/sandbox/url` reports `ready:true`,
  // so the hook only exposes URLs once the per-project runtime is actually
  // listening. Without this gate, a project navigated to right after the
  // home composer's `runtime/prewarm` would see canvas / preview / agent
  // SSE all hit ECONNREFUSED for the first few seconds while Vite + the
  // agent-runtime were still booting. We extend the existing
  // `isLoading || !project` guard below with `!runtimeReady` so the
  // project page shows a spinner ("Starting your project…") instead of
  // rendering panels that would silently fail.
  const {
    agentUrl: resolvedAgentUrl,
    previewUrl,
    canvasBaseUrl,
    ready: runtimeReady,
  } = useAgentUrl(API_URL!, projectId, {
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

  // Tracks whether we've already synced the persisted preference to the
  // runtime for this (project, model). Without this sync, Capabilities shows
  // the AsyncStorage-restored model while Overview shows whatever the agent
  // booted with — because the bootstrap previously only updated React state.
  const modelPrefSyncedRef = useRef<string | null>(null)
  useEffect(() => {
    let cancelled = false
    loadModelPreference(projectId).then((stored) => {
      if (cancelled) return
      const next = stored ?? (hasAdvancedModelAccess ? DEFAULT_MODEL_PRO : DEFAULT_MODEL_FREE)
      setSelectedModel(next)
      if (!agentUrl) return
      const syncKey = `${projectId}:${next}`
      if (modelPrefSyncedRef.current === syncKey) return
      modelPrefSyncedRef.current = syncKey
      const entry = MODEL_CATALOG[next as keyof typeof MODEL_CATALOG]
      if (!entry) return
      agentFetch(`${agentUrl}/agent/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: { provider: entry.provider, name: entry.id } }),
      }).catch((err) => {
        console.error('[ProjectLayout] Failed to sync persisted model to runtime:', err)
        modelPrefSyncedRef.current = null
      })
    })
    return () => { cancelled = true }
  }, [hasAdvancedModelAccess, projectId, agentUrl])

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

  const splitRowRef = useRef<View>(null)

  // Connection state for the canvas. The canvas iframe owns its own data
  // (SSE / HMR / API calls happen inside the workspace SPA); the parent
  // only needs to know whether the agent runtime is reachable.
  const connected = !!agentUrl

  // Stub `reconnect` for callers that still trigger a manual canvas refresh.
  // Bumping `iframeRefreshKey` reloads the iframe; v1's SSE reconnect path
  // is gone.
  const reconnect = useCallback(() => {
    setIframeRefreshKey(k => k + 1)
  }, [])

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
        // Fall back to the first workspace the user belongs to when nothing
        // has been persisted yet — otherwise the project-list preload is
        // silently skipped and the sidebar's Recent stays empty on a fresh
        // load that lands on a project URL.
        const wsId =
          getActiveWorkspaceId() ?? (store.workspaceCollection.all?.[0] as any)?.id
        const projectFilter = workspaceProjectFilter(wsId)
        if (projectFilter) {
          store.projectCollection
            .loadAll(projectFilter)
            .catch((e) => console.error('[ProjectLayout] Failed to preload projects:', e))
        }
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
  /**
   * Per-tab seed messages auto-sent when a freshly-created chat session mounts.
   * Used by the canvas-error → "Debug" flow to spawn a new chat that opens
   * pre-loaded with a debug prompt. Cleaned up when the tab closes.
   */
  const [debugInitMessages, setDebugInitMessages] = useState<Record<string, string>>({})
  /**
   * Tri-state hydration status for the open-tabs list:
   * - 'loading': haven't read AsyncStorage yet
   * - 'restored-with-tabs': storage had a non-empty list, restored it
   * - 'restored-empty': storage had an explicit `[]` (user previously closed everything)
   * - 'fresh': no storage key — first visit to this project, OK to auto-create
   * Distinguishing 'restored-empty' from 'fresh' is what prevents the auto-select
   * effect from resurrecting a tab the user just closed.
   */
  type TabsHydration = 'loading' | 'restored-with-tabs' | 'restored-empty' | 'fresh'
  const [tabsHydration, setTabsHydration] = useState<TabsHydration>('loading')
  const openTabsRestoredRef = useRef(false)

  // Restore open tabs from AsyncStorage on mount
  useEffect(() => {
    if (!projectId || openTabsRestoredRef.current) return
    AsyncStorage.getItem(`shogo:chatTabs:${projectId}`).then((raw) => {
      if (raw === null) {
        openTabsRestoredRef.current = true
        setTabsHydration('fresh')
        return
      }
      try {
        const ids = JSON.parse(raw)
        if (Array.isArray(ids)) {
          if (ids.length > 0) {
            setOpenChatTabIds(ids)
            openTabsRestoredRef.current = true
            setTabsHydration('restored-with-tabs')
            return
          }
          openTabsRestoredRef.current = true
          setTabsHydration('restored-empty')
          return
        }
      } catch { /* ignore malformed data */ }
      // Malformed payload — treat as fresh so we still auto-create.
      openTabsRestoredRef.current = true
      setTabsHydration('fresh')
    }).catch(() => {
      openTabsRestoredRef.current = true
      setTabsHydration('fresh')
    })
  }, [projectId])

  // Persist open tabs to AsyncStorage on every change, including `[]`.
  // Storing the explicit empty array is what lets the next mount distinguish
  // "user closed everything" from "first-ever visit".
  useEffect(() => {
    if (!projectId || tabsHydration === 'loading') return
    AsyncStorage.setItem(`shogo:chatTabs:${projectId}`, JSON.stringify(openChatTabIds)).catch(() => {})
  }, [projectId, openChatTabIds, tabsHydration])

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
    setCompletedTabIds((prev) => {
      if (!prev.has(tabId)) return prev
      const next = new Set(prev)
      next.delete(tabId)
      return next
    })
    setDebugInitMessages((prev) => {
      if (!(tabId in prev)) return prev
      const next = { ...prev }
      delete next[tabId]
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
          // Belt-and-suspenders: clear the "last chat session" pointer so a
          // future visit (or a stray run of the auto-select effect) can't
          // resurrect the just-closed session id.
          if (projectId) {
            AsyncStorage.removeItem(`shogo:lastChatSession:${projectId}`).catch(() => {})
          }
        }
      }
      return next
    })
  }, [chatSessionId, projectId])

  const SESSION_PAGE_SIZE = 10

  // Tracks which projects we've already seeded via loadPage so we don't
  // re-fetch the session list on every chatSessionId change. Without this,
  // each mounted ChatPanel would fall back to its own per-session fetch
  // (the root cause of the "[ChatPanel] Loading session from API" storm
  // when a project restores many open tabs).
  const seededProjectsRef = useRef<Set<string>>(new Set())

  // Seed the chat session collection and, when no session is selected yet,
  // auto-select or create one. The seed always runs once per projectId; the
  // auto-select/create branch only runs on a *fresh* visit (no prior tabs in
  // storage). For 'restored-with-tabs' the dedicated effect below picks an
  // active tab from the restored list, and 'restored-empty' is honored as a
  // user-intent "no tabs open" state — we deliberately do NOT auto-select.
  useEffect(() => {
    if (!projectId || !store?.chatSessionCollection) return

    let cancelled = false

    const run = async () => {
      if (!seededProjectsRef.current.has(projectId)) {
        try {
          await store.chatSessionCollection.loadPage(
            { contextId: projectId },
            { limit: SESSION_PAGE_SIZE, offset: 0 },
          )
          seededProjectsRef.current.add(projectId)
        } catch (err) {
          console.error('[ProjectLayout] Failed to seed chat sessions:', err)
        }
        if (cancelled) return
      }

      if (chatSessionId) return
      // Wait for restore to finish so we know which branch to take.
      if (tabsHydration === 'loading') return
      // Only auto-select / auto-create on a truly fresh visit. On
      // 'restored-with-tabs' the picker effect handles it; on 'restored-empty'
      // we honor the user's explicit close.
      if (tabsHydration !== 'fresh') return

      try {
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

    run()
    return () => {
      cancelled = true
    }
  }, [projectId, store, chatSessionId, actions, tabsHydration])

  // After a 'restored-with-tabs' hydration, choose which restored tab is
  // active. Prefer the persisted `lastChatSession` if it's still in the list,
  // otherwise the first restored tab. Tracked per-project so navigating
  // between projects in the same mount still works.
  const pickedFromRestoreRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!projectId) return
    if (pickedFromRestoreRef.current.has(projectId)) return
    if (tabsHydration !== 'restored-with-tabs') return
    if (chatSessionId) {
      pickedFromRestoreRef.current.add(projectId)
      return
    }
    if (openChatTabIds.length === 0) return
    let cancelled = false
    AsyncStorage.getItem(`shogo:lastChatSession:${projectId}`).then((lastId) => {
      if (cancelled) return
      const pick = lastId && openChatTabIds.includes(lastId) ? lastId : openChatTabIds[0]
      if (pick) {
        pickedFromRestoreRef.current.add(projectId)
        setChatSessionId(pick)
      }
    }).catch(() => {
      if (cancelled) return
      const pick = openChatTabIds[0]
      if (pick) {
        pickedFromRestoreRef.current.add(projectId)
        setChatSessionId(pick)
      }
    })
    return () => { cancelled = true }
  }, [projectId, tabsHydration, openChatTabIds, chatSessionId])

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
  // Hydrated from AsyncStorage so the user's "history sidebar open/closed"
  // preference survives navigation; only read once per project mount.
  const showChatSessionsHydratedRef = useRef<string | null>(null)
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false)
  // Narrow (mobile) chat-session picker that temporarily replaces the chat
  // panel with the session list. Auto-closes when the user leaves the chat tab.
  const [narrowChatPickerOpen, setNarrowChatPickerOpen] = useState(false)
  const [previewTab, setPreviewTab] = useState('canvas')

  // Close the narrow picker as soon as the layout shifts off the chat tab
  // (e.g. user switched to canvas, or the viewport widened into split mode).
  useEffect(() => {
    if (narrowChatPickerOpen && (isWide || activeTab !== 'chat')) {
      setNarrowChatPickerOpen(false)
    }
  }, [narrowChatPickerOpen, isWide, activeTab])

  useEffect(() => {
    if (!projectId) return
    if (showChatSessionsHydratedRef.current === projectId) return
    showChatSessionsHydratedRef.current = projectId
    AsyncStorage.getItem(`shogo:showChatHistory:${projectId}`).then((raw) => {
      if (raw === '1') setShowChatSessions(true)
      else if (raw === '0') setShowChatSessions(false)
    }).catch(() => {})
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    if (showChatSessionsHydratedRef.current !== projectId) return
    AsyncStorage.setItem(`shogo:showChatHistory:${projectId}`, showChatSessions ? '1' : '0').catch(() => {})
  }, [projectId, showChatSessions])

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

  const PERSISTABLE_PREVIEW_TABS = useMemo(() => new Set(['canvas', 'chat-fullscreen', 'app-preview', 'external-preview']), [])

  useEffect(() => {
    if (!projectId) return
    AsyncStorage.getItem(`shogo:lastPreviewTab:${projectId}`).then((saved) => {
      if (!saved) return
      // Legacy values written before the v1 dynamic-app -> canvas tab rename
      // (chore/remove-canvas-v1) get normalized on read so existing users don't
      // land on an unknown tab and fall back to the default.
      const normalized = saved === 'dynamic-app' ? 'canvas' : saved
      setPreviewTab(normalized)
    }).catch(() => {})
  }, [projectId])

  useEffect(() => {
    if (projectId && previewTab && PERSISTABLE_PREVIEW_TABS.has(previewTab)) {
      AsyncStorage.setItem(`shogo:lastPreviewTab:${projectId}`, previewTab).catch(() => {})
    }
  }, [projectId, previewTab, PERSISTABLE_PREVIEW_TABS])

  const [chatMessages, setChatMessages] = useState<any[]>([])
  const [streamingTabIds, setStreamingTabIds] = useState<Set<string>>(new Set())
  const [completedTabIds, setCompletedTabIds] = useState<Set<string>>(new Set())
  // Tracks the active chat tab so streaming-change callbacks (which capture an
  // older closure) can decide whether a finishing stream belongs to the tab
  // the user is currently looking at.
  const activeChatTabIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeChatTabIdRef.current = chatSessionId
  }, [chatSessionId])
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
    setCompletedTabIds((prev) => {
      if (isStreaming) {
        if (!prev.has(tabId)) return prev
        const next = new Set(prev)
        next.delete(tabId)
        return next
      }
      // Stream finished: only flag the tab when the user isn't looking at it.
      if (tabId === activeChatTabIdRef.current) return prev
      if (prev.has(tabId)) return prev
      const next = new Set(prev)
      next.add(tabId)
      return next
    })
  }, [])
  // Clear the "new activity" dot once the user opens that tab.
  useEffect(() => {
    if (!chatSessionId) return
    setCompletedTabIds((prev) => {
      if (!prev.has(chatSessionId)) return prev
      const next = new Set(prev)
      next.delete(chatSessionId)
      return next
    })
  }, [chatSessionId])
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
  const buildPlanNonceRef = useRef(0)
  const openPlanNonceRef = useRef(0)
  const [requestedPlanPath, setRequestedPlanPath] = useState<{ filepath: string | null; nonce: number } | null>(null)
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
      // Canvas is off. For folder-linked external projects we have a
      // first-class preview surface (the embedded Electron webview), so
      // land there by default; users still get chat-fullscreen for
      // managed-but-canvas-off projects, where there's no preview to
      // show.
      if (previewTab === 'canvas') {
        setPreviewTab(isExternalProject ? 'external-preview' : 'chat-fullscreen')
      }
    } else if (canvasEnabled) {
      if (previewTab === 'app-preview') setPreviewTab('canvas')
    }
  }, [canvasEnabled, activeMode, previewTab, activeTab, isExternalProject])

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
    if (key === 'canvasEnabled' && !enabled && previewTab === 'canvas') {
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
      setPreviewTab('canvas')
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

    // Destructive: replace project files with the new stack's starter. The
    // confirmation prompt lives in CapabilitiesPanel; by the time we get here
    // the user has already approved the wipe. The runtime preserves
    // .shogo/, memory/, .git/, and .canvas-state.json; everything else is
    // replaced with the new stack's starter and the preview is restarted.
    if (agentUrl) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (nativeHeaders) Object.assign(headers, nativeHeaders())
        const res = await fetch(`${agentUrl}/agent/workspace/reset-stack`, {
          method: 'POST',
          headers,
          credentials: Platform.OS === 'web' ? 'include' : 'omit',
          body: JSON.stringify({ stackId }),
        })
        if (!res.ok) {
          console.error('[ProjectLayout] Tech stack reset failed:', res.status, await res.text().catch(() => ''))
        } else {
          // Force the canvas iframe to reload so the new stack's starter
          // shows up as soon as the preview server comes back online.
          setIframeRefreshKey((k) => k + 1)
        }
      } catch (err) {
        console.error('[ProjectLayout] Failed to reset workspace to new tech stack:', err)
      }
    }
  }, [updateProjectSettings, agentUrl, nativeHeaders])

  const handleBuildPlan = useCallback((plan: any, modelId: string) => {
    buildPlanNonceRef.current += 1
    setBuildPlanRequest({ plan, modelId, nonce: buildPlanNonceRef.current })
    setActiveTab('chat')
    if (canvasEnabled) {
      setPreviewTab('canvas')
    } else {
      setPreviewTab('chat-fullscreen')
    }
  }, [canvasEnabled])

  const handleBuildPlanConsumed = useCallback((nonce: number) => {
    setBuildPlanRequest((curr) => (curr && curr.nonce === nonce ? null : curr))
  }, [])

  const handleOpenPlan = useCallback((filepath?: string | null) => {
    openPlanNonceRef.current += 1
    setRequestedPlanPath({ filepath: filepath ?? null, nonce: openPlanNonceRef.current })
    setPreviewTab('plans')
    if (!isWide) setActiveTab('canvas')
  }, [isWide])

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
            await sessionMessages.loadAll({ sessionId: s.id, agent: 'technical' })
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

  // ─── Canvas-error → "Debug" toast ───────────────────────────────────────
  // The canvas iframe (and its ShogoErrorBoundary) postMessage `canvas-error`
  // back to the parent on uncaught render / runtime / compile failures. We
  // surface a toast with a "Debug" button that spins up a fresh chat
  // pre-loaded with the error + recent runtime-log tail.
  const lastCanvasErrorRef = useRef<{ key: string; ts: number } | null>(null)
  const openDebugChatForCanvasError = useCallback(
    async (
      surfaceId: string,
      phase: 'compile' | 'runtime',
      error: string,
      context?: {
        route?: string
        recentActions?: ReadonlyArray<{ ts: number; kind: string; target?: string; route?: string }>
      },
    ) => {
      if (!projectId) return
      try {
        const recentLogs = getRuntimeLogEntries(projectId).slice(-CANVAS_ERROR_LOG_TAIL)
        const prompt = buildCanvasErrorDebugPrompt({
          surfaceId,
          surfaceTitle: null,
          phase,
          error,
          route: context?.route,
          recentActions: context?.recentActions,
          recentLogs,
        })

        const newSession = await actions.createChatSession({
          inferredName: `Debug: ${phase} error`,
          contextType: 'project',
          contextId: projectId,
        })
        if (!newSession?.id) return
        const newId = newSession.id

        setDebugInitMessages((prev) => ({ ...prev, [newId]: prompt }))
        setOpenChatTabIds((prev) =>
          prev.includes(newId) ? prev : [...prev, newId],
        )
        setChatSessionId(newId)
        // Narrow layouts hide the chat column behind the canvas tab, so flip
        // back to it. Wide layouts already show the chat column alongside the
        // canvas — leave the preview pane (canvas / IDE / etc.) untouched.
        if (!isWide) setActiveTab('chat')
      } catch (err) {
        console.error('[ProjectLayout] Failed to open debug chat:', err)
      }
    },
    [projectId, actions, isWide],
  )

  const handleCanvasError = useCallback(
    (
      surfaceId: string,
      phase: 'compile' | 'runtime',
      error: string,
      context?: {
        route?: string
        recentActions?: ReadonlyArray<{ ts: number; kind: string; target?: string; route?: string }>
      },
    ) => {
      if (!projectId) return
      // Dedup: the canvas iframe re-throws the same error on every retry /
      // HMR loop. One toast per unique error within the dedup window.
      const key = `${surfaceId}|${phase}|${error}`
      const now = Date.now()
      const last = lastCanvasErrorRef.current
      if (last && last.key === key && now - last.ts < CANVAS_ERROR_DEDUP_MS) {
        return
      }
      lastCanvasErrorRef.current = { key, ts: now }

      const phaseWord = phase === 'compile' ? 'Compile-time' : 'Runtime'
      const where = context?.route ? ` on ${context.route}` : ''
      const description = where
        ? `${phaseWord} error${where}.`
        : `${phaseWord} error in the canvas.`
      const toastId = `canvas-error-${surfaceId}-${now}`

      toast.show({
        id: toastId,
        placement: 'top',
        duration: 12_000,
        render: ({ id: tId }: { id: string }) => (
          <Toast nativeID={tId} variant="solid" action="error">
            <View className="flex-row items-start gap-2">
              <View className="mt-0.5">
                <Bug size={16} className="text-typography-0" />
              </View>
              <View className="flex-1">
                <ToastTitle>Canvas error</ToastTitle>
                <ToastDescription>{description}</ToastDescription>
              </View>
            </View>
            <View className="mt-2 flex-row gap-2">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Debug this canvas error in a new chat"
                onPress={() => {
                  toast.close(tId)
                  void openDebugChatForCanvasError(surfaceId, phase, error, context)
                }}
                className="flex-row items-center gap-1.5 rounded-md bg-white/95 px-3 py-1.5 active:opacity-80"
              >
                <Bug size={12} className="text-error-700" />
                <Text className="text-xs font-semibold text-error-700">
                  Debug
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss canvas error"
                onPress={() => toast.close(tId)}
                className="flex-row items-center gap-1 rounded-md border border-white/30 px-3 py-1.5 active:opacity-80"
              >
                <XIcon size={12} className="text-typography-0" />
                <Text className="text-xs font-medium text-typography-0">
                  Dismiss
                </Text>
              </Pressable>
            </View>
          </Toast>
        ),
      })
    },
    [projectId, toast, openDebugChatForCanvasError],
  )

  const handleRenameChatSession = useCallback(
    async (sessionId: string, newName: string) => {
      try {
        await actions.updateChatSession(sessionId, { name: newName })
        // Flush into the local sessionNames cache so the useMemo dep changes
        // and chatSessions recomputes immediately.
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
        // No client-side EZ Mode teardown needed: voice rows are stored
        // in chat_messages with agent="voice" and cascade-delete with
        // the ChatSession on the server.
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
    if (!capturedShowIntegrations || !project?.id) return
    let cancelled = false

    // After install, the marketplace install row carries the listing
    // slug. We fetch the listing's longDescription/integrations from
    // /api/marketplace/<slug> and render the suggestion card. The
    // legacy templateId-based lookup was retired with the templates →
    // marketplace consolidation.
    async function lookupIntegrations() {
      try {
        const installRes = await http.get<{
          install?: { listing?: { slug?: string } }
        }>(`/api/marketplace/installs/by-project/${encodeURIComponent(project.id)}`)
        if (cancelled) return
        const slug = installRes.data?.install?.listing?.slug
        if (!slug) return
        const listingRes = await http.get<{
          listing?: { title?: string; integrations?: TemplateIntegrationRef[] }
        }>(`/api/marketplace/${encodeURIComponent(slug)}`)
        if (cancelled) return
        const integrations = listingRes.data?.listing?.integrations
        if (integrations?.length) {
          setIntegrationsCardData({
            integrations,
            templateName: listingRes.data?.listing?.title ?? '',
          })
        }
      } catch (err) {
        console.warn('[ProjectLayout] Failed to look up listing integrations:', err)
      }
    }

    lookupIntegrations()
    return () => { cancelled = true }
  }, [capturedShowIntegrations, project?.id, http])

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
  // `refetchUsageWallet` callback is wrapped in useCallback([]) inside the
  // hook, so its identity is already stable across renders.
  const billingHasActive = features.billing ? billingData.hasActiveSubscription : true
  const billingHasAdvanced = features.billing ? billingData.hasAdvancedModelAccess : true
  const billingRefetch = billingData.refetchUsageWallet
  const billingDataResolved = useMemo(
    () => ({
      hasActiveSubscription: billingHasActive,
      hasAdvancedModelAccess: billingHasAdvanced,
      refetchUsageWallet: billingRefetch,
    }),
    [billingHasActive, billingHasAdvanced, billingRefetch],
  )

  // Loading state. We also gate on `runtimeReady` so the panels never
  // render with stale URLs — see `useAgentUrl` for the polling contract.
  // The copy differs once project metadata has loaded but the per-project
  // runtime is still booting, so the user understands why the wait is
  // happening (a remote instance pins its own URL via `localAgentUrl`,
  // which `useAgentUrl` treats as immediately-ready, so this only
  // surfaces for the host/VM/K8s paths).
  if (isLoading || !project || (!remoteProjectAgentBaseUrl && !runtimeReady)) {
    const stillBootingRuntime = !isLoading && project && !remoteProjectAgentBaseUrl && !runtimeReady
    return (
      <>
        <Stack.Screen options={HIDDEN_HEADER_OPTIONS} />
        <View className="flex-1 bg-background items-center justify-center">
          <ActivityIndicator size="large" />
          <Text className="text-muted-foreground mt-3 text-sm">
            {stillBootingRuntime ? 'Starting your project…' : 'Loading project...'}
          </Text>
        </View>
      </>
    )
  }

  /**
   * No tabs are open and we've finished hydrating from storage. This is the
   * post-fix "user closed everything" state — show the chat history list so
   * they can pick an existing session or start a new one. While
   * `tabsHydration === 'loading'` we render nothing extra to avoid flashing
   * the empty state for one frame on every mount.
   */
  const showEmptyChatState = tabsHydration !== 'loading' && openChatTabIds.length === 0

  const renderEmptyChatList = (onSelectClose?: () => void) => (
    <ChatSessionSidebar
      sessions={chatSessions}
      currentSessionId={undefined}
      onSelect={(sessionId) => {
        setOpenChatTabIds((prev) => prev.includes(sessionId) ? prev : [...prev, sessionId])
        setChatSessionId(sessionId)
        onSelectClose?.()
      }}
      onCreate={() => {
        void handleCreateNewSession()
        onSelectClose?.()
      }}
      onRename={handleRenameChatSession}
      onLoadMore={handleLoadMoreSessions}
      hasMore={store?.chatSessionCollection?.hasMore ?? false}
      isLoadingMore={store?.chatSessionCollection?.isLoadingMore ?? false}
      hideHeader
      searchOpen={sidebarSearchOpen}
      onSearchClose={() => setSidebarSearchOpen(false)}
    />
  )

  const chatPanels = (
    <>
      {openChatTabIds.map((tabId) => {
        const isActive = tabId === chatSessionId
        const isInitialSession = tabId === initialPropsSessionId
        const debugSeed = debugInitMessages[tabId]
        return (
          <View
            key={tabId}
            className="flex-1"
            style={!isActive ? { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0 } : undefined}
            pointerEvents={isActive ? 'auto' : 'none'}
          >
            <PanelErrorBoundary panelName="Chat">
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
                initialMessage={isInitialSession ? capturedInitialMessage : (debugSeed ?? undefined)}
                initialInteractionMode={isInitialSession ? capturedInitialInteractionMode : undefined}
                initialFiles={isInitialSession ? capturedInitialFiles : undefined}
                billingData={billingDataResolved}
                onMessagesChange={isActive ? setChatMessages : undefined}
                onStreamingChange={getStreamingChangeHandler(tabId)}
                buildPlanRequest={isActive ? buildPlanRequest : null}
                onBuildPlanConsumed={isActive ? handleBuildPlanConsumed : undefined}
                onOpenPlan={handleOpenPlan}
                selectedModel={selectedModel}
                onModelChange={handleModelChange}
                className="flex-1"
              />
            </PanelErrorBoundary>
          </View>
        )
      })}
    </>
  )

  const canvasPanel = canvasEnabled ? (
    <CanvasPanel
      agentUrl={agentUrl}
      canvasBaseUrl={canvasBaseUrl}
      onRefresh={reconnect}
      fullBleed={!isWide}
      iframeRefreshKey={iframeRefreshKey}
      onCanvasCapabilities={handleCanvasCapabilities}
      onCanvasError={handleCanvasError}
    />
  ) : null

  const hiddenTabs: string[] = ['app-preview'] // APP_MODE_DISABLED: always hide app-preview
  if (activeMode !== 'canvas') hiddenTabs.push('canvas')
  // Hide the external-only tabs on managed projects so the top-bar
  // stays uncluttered. The renderer/state for these panels is
  // workingMode-aware too, so even a direct deep-link won't render
  // them for managed projects.
  if (!isExternalProject) {
    hiddenTabs.push('external-preview')
    hiddenTabs.push('folders')
  }

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
    usdRemaining,
    usdTotal,
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
    showChatSessions: isChatFullscreen ? false : showChatSessions,
    isChatCollapsed: isChatFullscreen ? true : chatCollapsed,
    onChatSessionsToggle: isChatFullscreen ? undefined : () => setShowChatSessions((s: boolean) => !s),
    onChatCollapseToggle: isChatFullscreen ? undefined : () => setChatCollapsed((c: boolean) => !c),
    onCreateNewSession: isChatFullscreen ? undefined : handleCreateNewSession,
    // Top bar chat zone spans the chat column. When the collapsible history
    // sidebar is open in split mode, include its 280px so the zone aligns.
    chatPanelWidth: clampChatWidth(chatPanelWidth) + (isWide && !isChatFullscreen && showChatSessions ? 280 : 0),
    chatFullscreenSidebarWidth: isChatFullscreen ? 280 : undefined,
    onSearchChats: isChatFullscreen ? () => setSidebarSearchOpen(true) : undefined,
    // Narrow-only: tapping the History icon swaps the chat panel for the
    // session list. Closing happens when the user picks/creates a session,
    // taps the icon again, or leaves the chat tab.
    onOpenChatSessions: !isWide ? () => setNarrowChatPickerOpen((p) => !p) : undefined,
    chatSessionsOpen: !isWide && narrowChatPickerOpen,
    onNewChat: isChatFullscreen ? handleCreateNewSession : undefined,
    onRenameChat: isChatFullscreen ? handleRenameChatSession : undefined,
    onDeleteChat: isChatFullscreen ? handleDeleteChatSession : undefined,
    activeChatSessionId: isChatFullscreen ? chatSessionId : undefined,
    activeChatSessionName: isChatFullscreen ? (chatSessions.find(s => s.id === chatSessionId)?.name ?? null) : undefined,
    canvasActive: canvasEnabled && previewTab === 'canvas',
    canvasThemeSupported,
    onCanvasRefresh: () => setIframeRefreshKey(k => k + 1),
    onCanvasOpenInNewTab:
      Platform.OS === 'web' && (canvasBaseUrl || agentUrl)
        ? () => {
            const base = canvasBaseUrl || agentUrl
            if (base) window.open(`${base}/`, '_blank', 'noopener,noreferrer')
          }
        : undefined,
  }

  return (
    <>
      <Stack.Screen options={HIDDEN_HEADER_OPTIONS} />

      <PlanStreamProvider>
      <ChatBridgeProvider
        chatSessionId={chatSessionId}
        agentUrl={agentUrl}
        initialEzModeActive={Platform.OS === 'web' && capturedStartEzMode}
        initialAutoStartVoice={Platform.OS === 'web' && capturedStartEzMode && capturedAutoStartVoice}
      >
      <View className="flex-1 bg-background">
          {isWide ? (
            <ProjectTopBar
              {...topBarSharedProps}
              onTabChange={handlePreviewTabChange}
            />
          ) : (
            <ProjectTopBar
              {...topBarSharedProps}
              narrowActiveTab={activeTab}
              narrowPreviewTab={previewTab}
              onNarrowTabChange={(tab: 'chat' | 'canvas') => {
                setActiveTab(tab)
                if (tab === 'canvas') {
                  setPreviewTab('canvas')
                } else {
                  // Clear standalone preview (files, capabilities, …) so the chat column shows
                  // and the next “canvas” visit doesn’t reopen the old panel on top.
                  setPreviewTab('chat-fullscreen')
                }
              }}
              onTabChange={(tabId: string) => {
                handlePreviewTabChange(tabId)
                if (tabId !== 'canvas' && tabId !== 'app-preview' && tabId !== 'chat-fullscreen') setActiveTab('canvas')
              }}
            />
          )}

          {/* Content — chat panel stays mounted across layout/tab changes */}
          <View className={cn('flex-1', isWide && 'flex-row')} ref={splitRowRef}>
            {/* Chat column — single mount point so ChatPanel never unmounts on mode switch */}
            {/* Sidebar is shown always in fullscreen and toggleable in wide-split via showChatSessions. */}
            {(() => {
              const showSidebar = isChatFullscreen || (isWide && showChatSessions)
              return (
                <View
                  className={cn(
                    'flex min-h-0',
                    isChatFullscreen
                      ? 'flex-1 flex-row'
                      : isWide
                        ? cn('shrink-0 bg-background z-10', showSidebar ? 'flex-row' : 'flex-col')
                        : 'relative flex-1 flex-col',
                    !isChatFullscreen && chatHidden && 'hidden',
                  )}
                  style={
                    !isChatFullscreen && isWide && !chatHidden
                      ? { width: clampChatWidth(chatPanelWidth) + (showSidebar ? 280 : 0) }
                      : undefined
                  }
                >
                  {showSidebar && (
                    <View className="w-[200px] bg-muted/50 dark:bg-black/30 border-r border-border">
                      <ChatSessionSidebar
                        sessions={chatSessions}
                        currentSessionId={chatSessionId ?? undefined}
                        onSelect={(sessionId) => {
                          setOpenChatTabIds((prev) => prev.includes(sessionId) ? prev : [...prev, sessionId])
                          setChatSessionId(sessionId)
                        }}
                        onCreate={handleCreateNewSession}
                        onRename={handleRenameChatSession}
                        onDelete={handleDeleteChatSession}
                        onLoadMore={handleLoadMoreSessions}
                        hasMore={store?.chatSessionCollection?.hasMore ?? false}
                        isLoadingMore={store?.chatSessionCollection?.isLoadingMore ?? false}
                        hideHeader
                        searchOpen={sidebarSearchOpen}
                        onSearchClose={() => setSidebarSearchOpen(false)}
                        streamingSessionIds={streamingTabIds}
                        completedSessionIds={completedTabIds}
                      />
                    </View>
                  )}
                  <View className="flex-1 min-h-0 relative">
                    <View
                      className="absolute inset-0"
                      style={showEmptyChatState || narrowChatPickerOpen ? { opacity: 0 } : undefined}
                      pointerEvents={showEmptyChatState || narrowChatPickerOpen ? 'none' : 'auto'}
                    >
                      <EzModeAwareChatPanels>{chatPanels}</EzModeAwareChatPanels>
                    </View>
                    {showEmptyChatState && (
                      isChatFullscreen || showSidebar ? (
                        <View className="absolute inset-0 bg-background items-center justify-center px-8">
                          <MessageSquare size={28} className="text-muted-foreground" />
                          <Text className="text-sm text-muted-foreground mt-3 text-center">
                            No chat open. Pick one from the list on the left, or start a new chat.
                          </Text>
                        </View>
                      ) : (
                        <View className="absolute inset-0 bg-background">
                          {renderEmptyChatList()}
                        </View>
                      )
                    )}
                    {!showEmptyChatState && narrowChatPickerOpen && !isWide && activeTab === 'chat' && (
                      <View className="absolute inset-0 bg-background">
                        <ChatSessionSidebar
                          sessions={chatSessions}
                          currentSessionId={chatSessionId ?? undefined}
                          onSelect={(sessionId) => {
                            setOpenChatTabIds((prev) =>
                              prev.includes(sessionId) ? prev : [...prev, sessionId],
                            )
                            setChatSessionId(sessionId)
                            setNarrowChatPickerOpen(false)
                          }}
                          onCreate={() => {
                            void handleCreateNewSession()
                            setNarrowChatPickerOpen(false)
                          }}
                          onRename={handleRenameChatSession}
                          onDelete={handleDeleteChatSession}
                          onLoadMore={handleLoadMoreSessions}
                          hasMore={store?.chatSessionCollection?.hasMore ?? false}
                          isLoadingMore={store?.chatSessionCollection?.isLoadingMore ?? false}
                          streamingSessionIds={streamingTabIds}
                          completedSessionIds={completedTabIds}
                        />
                      </View>
                    )}
                  </View>
                </View>
              )
            })()}

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
                leftOffset={showChatSessions ? 280 : 0}
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
          <DrawerHost
            projectId={projectId ?? null}
            agentUrl={agentUrl ?? null}
            messages={chatMessages}
            platformIsWeb={Platform.OS === 'web'}
            canvasAreaHidden={canvasAreaHidden}
            isChatFullscreen={isChatFullscreen}
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

          {canvasEnabled && previewTab === 'canvas' && (
            <View className="absolute inset-0">
              <PanelErrorBoundary panelName="Canvas">
                {canvasPanel}
              </PanelErrorBoundary>
            </View>
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
            <PanelErrorBoundary panelName="IDE">
              <IDEPanel visible={previewTab === 'ide'} projectId={projectId!} projectName={project.name} agentUrl={agentUrl} />
            </PanelErrorBoundary>
            <PanelErrorBoundary panelName="Files">
              <FilesBrowserPanel visible={previewTab === 'files'} projectId={projectId!} agentUrl={agentUrl} />
            </PanelErrorBoundary>
            <PanelErrorBoundary panelName="Capabilities">
              <CapabilitiesPanel visible={previewTab === 'capabilities'} projectId={projectId!} agentUrl={agentUrl} capabilities={capabilitySettings} onCapabilityToggle={handleCapabilityToggle} isPaidPlan={effectiveHasActiveSubscription} activeMode={activeMode} onModeChange={handleManualModeChange} techStackId={techStackId} onTechStackChange={handleTechStackChange} selectedModel={selectedModel} onModelChange={handleModelChange} />
            </PanelErrorBoundary>
            <PanelErrorBoundary panelName="Channels">
              <ChannelsPanel visible={previewTab === 'channels'} projectId={projectId!} workspaceId={project?.workspaceId} agentUrl={agentUrl} hasAdvancedModelAccess={features.billing ? billingData.hasAdvancedModelAccess : true} />
            </PanelErrorBoundary>
            <PanelErrorBoundary panelName="Agents">
              <AgentsPanel visible={previewTab === 'agents'} selectedToolId={selectedAgentToolId} agentUrl={agentUrl} />
            </PanelErrorBoundary>
            <PanelErrorBoundary panelName="Monitor">
              <MonitorPanel visible={previewTab === 'monitor'} projectId={projectId!} agentUrl={agentUrl} isPaidPlan={effectiveHasActiveSubscription} />
            </PanelErrorBoundary>
            <PanelErrorBoundary panelName="Plans">
              <PlansPanel visible={previewTab === 'plans'} projectId={projectId!} agentUrl={agentUrl} selectedModel={selectedModel} requestedPlanPath={requestedPlanPath} onBuildPlan={handleBuildPlan} />
            </PanelErrorBoundary>
            <PanelErrorBoundary panelName="Checkpoints">
              <CheckpointsPanel visible={previewTab === 'checkpoints'} projectId={projectId!} />
            </PanelErrorBoundary>
            <PanelErrorBoundary panelName="Folders">
              <FoldersPanel
                visible={previewTab === 'folders'}
                projectId={projectId!}
                onChange={() => {
                  // Re-pull the project so workingMode/trust/folders
                  // changes propagate without a full page refresh.
                  if (projectId) {
                    void fetch(
                      `${API_URL}/api/projects/${encodeURIComponent(projectId)}?include=projectFolders`,
                      { credentials: Platform.OS === 'web' ? 'include' : 'omit' },
                    )
                      .then((r) => (r.ok ? r.json() : null))
                      .then((data) => {
                        const next = data?.project ?? data
                        if (next) setProject(next)
                      })
                      .catch(() => {})
                  }
                }}
              />
            </PanelErrorBoundary>
            <PanelErrorBoundary panelName="ExternalPreview">
              {previewTab === 'external-preview' && (
                <ExternalPreviewWebView
                  projectId={projectId!}
                  url={externalSavedUrl ?? externalDetectedUrl ?? null}
                  visible={previewTab === 'external-preview'}
                  detectedUrl={externalDetectedUrl}
                  onUrlSubmit={handleSaveExternalPreviewUrl}
                  isTrusted={projectTrustLevel === 'trusted'}
                  onTrustRequired={() => setTrustPromptOpen(true)}
                />
              )}
            </PanelErrorBoundary>
          </View>
          </DrawerHost>
        </View>

        {/* Workspace trust prompt — first-mount only, dismissible. */}
        {isExternalProject ? (
          <TrustPrompt
            open={trustPromptOpen}
            projectName={project?.name}
            folderPath={primaryFolderPath ?? undefined}
            isSubmitting={trustSubmitting}
            onDecision={handleTrustDecision}
            onClose={() => setTrustPromptOpen(false)}
          />
        ) : null}

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
    </ChatBridgeProvider>

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
// EzModeAwareChatPanels — wraps `{chatPanels}` and overlays `EzModeChatPanel`
// on top (absolute inset-0) when the user has EZ Mode enabled. The
// underlying `ChatPanel` stack stays mounted beneath so its `ChatBridge`
// registration (send / setMode / assistant emit) stays live — the
// translator drives those imperatively.
// ---------------------------------------------------------------------------

function EzModeAwareChatPanels({ children }: { children: React.ReactNode }) {
  const { ezModeActive, ezPeekActive, setEzPeekActive } = useChatBridge()
  const { features } = usePlatformConfig()
  const showEzMode = Platform.OS === 'web' && ezModeActive && features.ezMode
  // "Peek" hides the EZ Mode overlay without tearing it down, so the voice
  // session + translator thread keep running while the user interacts
  // with the real ChatPanel underneath.
  const hideForPeek = showEzMode && ezPeekActive
  return (
    <View className="min-h-0 flex-1 relative">
      <View
        className="absolute inset-0"
        style={showEzMode && !hideForPeek ? { opacity: 0 } : undefined}
        pointerEvents={showEzMode && !hideForPeek ? 'none' : 'auto'}
      >
        {children}
      </View>
      {showEzMode && (
        <View
          className="absolute inset-0 z-10 bg-background"
          style={hideForPeek ? { opacity: 0 } : undefined}
          pointerEvents={hideForPeek ? 'none' : 'auto'}
        >
          <EzModeChatPanel />
        </View>
      )}
      {hideForPeek && (
        <View
          className="absolute bottom-4 right-4 z-30"
          pointerEvents="box-none"
        >
          <Pressable
            onPress={() => setEzPeekActive(false)}
            className="flex-row items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 shadow-lg"
            accessibilityLabel="Return to EZ Mode"
          >
            <Sparkles size={12} className="text-primary-foreground" />
            <Text className="text-[11px] font-semibold text-primary-foreground">
              Return to EZ Mode
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

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
  leftOffset = 0,
}: {
  splitRowRef: React.RefObject<View | null>
  chatPanelWidth: number
  minWidth: number
  maxWidth: number
  onResize: (w: number) => void
  onResizeEnd: (w: number) => void
  defaultWidth: number
  /** Pixels of fixed-width content (e.g. the chat history sidebar) sitting to the left of the resizable chat panel. */
  leftOffset?: number
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
      const newWidth = Math.max(
        minWidth,
        Math.min(maxWidth, ev.clientX - containerRect.left - leftOffset),
      )
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
  }, [splitRowRef, minWidth, maxWidth, onResize, onResizeEnd, leftOffset])

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
// Canvas Panel — renders the v2 canvas iframe (Vite-built workspace SPA)
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
  agentUrl,
  canvasBaseUrl,
  onRefresh,
  iframeRefreshKey = 0,
  onCanvasCapabilities,
  onCanvasError,
}: {
  agentUrl: string | null
  canvasBaseUrl?: string | null
  onRefresh?: () => void
  fullBleed?: boolean
  iframeRefreshKey?: number
  onCanvasCapabilities?: (caps: { supportsTheme: boolean }) => void
  onCanvasError?: (
    surfaceId: string,
    phase: 'compile' | 'runtime',
    error: string,
    context?: {
      route?: string
      recentActions?: ReadonlyArray<{ ts: number; kind: string; target?: string; route?: string }>
    },
  ) => void
}) {
  // Poll the preview URL's /health endpoint until the DomainMapping propagates.
  // Until ready, treat canvasBaseUrl as null so the loading screen stays visible.
  const readyCanvasBaseUrl = usePreviewReadiness(canvasBaseUrl)

  // Phase-level visibility into what the runtime is doing while we wait
  // (installing deps, building, starting the API server, …). Drives the
  // user-facing "what's happening" label below in place of the previous
  // generic "Connecting to agent runtime…" + misleading "Send a message
  // in the Chat tab to wake the agent" hint (the runtime already starts
  // via `runtime/prewarm`; chat sends are not what wakes it).
  const { phase: previewPhase } = usePreviewPhase(agentUrl)

  const CONNECTION_TIMEOUT_MS = 60_000
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (agentUrl && readyCanvasBaseUrl) {
      setTimedOut(false)
      return
    }
    setTimedOut(false)
    const timer = setTimeout(() => setTimedOut(true), CONNECTION_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [agentUrl, readyCanvasBaseUrl])

  if (!agentUrl || !readyCanvasBaseUrl) {
    const phaseLabel =
      previewPhase && previewPhase !== 'idle'
        ? PHASE_LABELS[previewPhase] ?? 'Preparing preview...'
        : !agentUrl
          ? 'Connecting to agent runtime...'
          : 'Loading preview...'
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
            <Text className="text-foreground font-medium text-base mb-1">
              {phaseLabel}
            </Text>
            <Text className="text-muted-foreground text-xs text-center">
              This usually takes 20-40 seconds
            </Text>
          </>
        )}
      </View>
    )
  }

  return (
    <View className="flex-1 overflow-hidden rounded-2xl mx-2 mb-2">
      <CanvasWebView
        agentUrl={agentUrl}
        canvasBaseUrl={readyCanvasBaseUrl}
        refreshKey={iframeRefreshKey}
        onCanvasCapabilities={onCanvasCapabilities}
        onCanvasError={onCanvasError}
      />
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

/**
 * Polls `${agentUrl}/preview/status` so callers can show the user *what*
 * the runtime is doing (installing deps, building, starting API, …)
 * rather than a generic spinner. Returns:
 *   phase    – PreviewManager phase string ('idle', 'installing', …)
 *   running  – true once the preview is fully up and the iframe / canvas
 *              should be loaded
 *
 * Polling stops as soon as `running === true` and resumes if the
 * `agentUrl` changes (e.g. the user navigates to a different project).
 *
 * Reused by both the AppPreviewPanel and CanvasPanel so their "waiting"
 * states stay consistent and the previously misleading "Send a message
 * in the Chat tab to wake the agent" hint can be replaced with real,
 * accurate phase labels.
 */
function usePreviewPhase(agentUrl: string | null): { phase: string; running: boolean } {
  const [phase, setPhase] = useState<string>('idle')
  const [running, setRunning] = useState<boolean>(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    // Reset on agentUrl change so consumers see a fresh "idle" phase on
    // navigation instead of a stale `running=true` from the previous
    // project.
    setPhase('idle')
    setRunning(false)

    if (!agentUrl) return

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
            setRunning(true)
            if (pollRef.current) {
              clearInterval(pollRef.current)
              pollRef.current = null
            }
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
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [agentUrl])

  return { phase, running }
}

function AppPreviewPanel({ previewUrl, agentUrl }: { previewUrl: string | null; agentUrl: string | null }) {
  const [iframeKey, setIframeKey] = useState(0)
  const { phase, running } = usePreviewPhase(agentUrl)
  // Latches once the preview reports `running`. Manual refresh resets it
  // so the user can re-trigger the iframe load if Vite/HMR drops.
  const [previewReady, setPreviewReady] = useState(false)
  useEffect(() => {
    if (running && !previewReady) {
      setPreviewReady(true)
      setIframeKey(k => k + 1)
    }
  }, [running, previewReady])

  // Reset ready state when previewUrl changes (new project)
  useEffect(() => {
    setPreviewReady(false)
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
