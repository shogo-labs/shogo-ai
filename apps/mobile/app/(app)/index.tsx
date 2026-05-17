// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
  ActivityIndicator,
  Alert,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import { ArrowRight } from 'lucide-react-native'
import Svg, { Defs, RadialGradient, Stop, Ellipse } from 'react-native-svg'
import { ProjectCard } from '../../components/home/ProjectCard'
import { cn } from '@shogo/shared-ui/primitives'
import { Button } from '@shogo/shared-ui/primitives'
import { usePostHogSafe } from '../../contexts/posthog'
import { useAuth } from '../../contexts/auth'
import {
  useProjectCollection,
  useWorkspaceCollection,
  useMemberCollection,
  useDomainActions,
  useDomainHttp,
} from '../../contexts/domain'
import type { IProject, IMember, IWorkspace } from '../../contexts/domain'
import { CompactChatInput } from '../../components/chat/CompactChatInput'
import type { FileAttachment, InteractionMode } from '../../components/chat/ChatInput'
import { DEFAULT_MODEL_PRO, DEFAULT_MODEL_FREE } from '../../components/chat/ChatInput'
import {
  loadInteractionModePreference,
  saveInteractionModePreference,
} from '../../lib/interaction-mode-preference'
import { loadModelPreference, saveModelPreference } from '../../lib/agent-mode-preference'
import { setPendingFiles } from '../../lib/pending-image-store'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useBillingData } from '@shogo/shared-app/hooks'
import { usePlatformConfig } from '../../lib/platform-config'
import { api, getOnboardingMessage } from '../../lib/api'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { safeGetItem, safeRemoveItem } from '../../lib/safe-storage'
import type { AgentTileListing } from '../../components/marketplace/AgentTile'
import { FolderPickerModal } from '../../components/local/FolderPickerModal'

/**
 * Home-rail listing shape. Mirrors `AgentTileListing` plus the
 * `description` we render in card layouts. Sourced from the
 * `/api/marketplace/featured` endpoint after the templates →
 * marketplace consolidation; what was once `getAgentTemplates()` now
 * comes from the same listings the marketplace browse surface uses.
 */
type HomeListing = AgentTileListing & { description?: string }

/**
 * Reads the dark class directly from the DOM and observes mutations.
 * Avoids relying on React context which MobX observer() can swallow.
 */
function useDarkMode() {
  const [isDark, setIsDark] = useState(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark')
    }
    return false
  })
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return
    setIsDark(document.documentElement.classList.contains('dark'))
    const obs = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return isDark
}

const GRADIENT_CSS = `
@keyframes lovable-drift {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(20px, -10px) scale(1.02); }
}
@keyframes lovable-drift-alt {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(-15px, 15px) scale(1.01); }
}
`


function generateProjectNameFromPrompt(prompt: string): string {
  const fillerWords = new Set([
    "a", "an", "the", "to", "for", "with", "that", "this", "is", "are",
    "my", "me", "its", "it", "our", "your", "their",
    "create", "build", "make", "design", "develop", "implement", "add", "include",
    "show", "showing", "display", "have", "has", "using", "use",
    "please", "can", "you", "i", "want", "need", "would", "like",
    "simple", "basic", "web", "app", "application", "website", "page",
    "where", "when", "how", "what", "which", "each", "every", "some",
    "and", "but", "also", "then", "from", "into", "about", "just",
    "nice", "good", "new", "should", "could",
  ])
  const words = prompt.toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(word => word.length > 2 && !fillerWords.has(word))
  const nameWords = words.slice(0, 3)
  if (nameWords.length === 0) return "New Project"
  return nameWords.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
}

const LovableGradient = memo(function LovableGradient({ isDark }: { isDark: boolean }) {
  if (Platform.OS !== 'web') {
    const o = isDark ? 0.35 : 1
    return (
      <View className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
        <Svg width="100%" height="100%" style={{ position: 'absolute' }}>
          <Defs>
            <RadialGradient id="orb1" cx="50%" cy="50%" rx="50%" ry="50%">
              <Stop offset="0%" stopColor="rgb(96,165,250)" stopOpacity={0.55 * o} />
              <Stop offset="40%" stopColor="rgb(147,197,253)" stopOpacity={0.35 * o} />
              <Stop offset="100%" stopColor="rgb(96,165,250)" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="orb2" cx="50%" cy="50%" rx="50%" ry="50%">
              <Stop offset="0%" stopColor="rgb(244,114,182)" stopOpacity={0.55 * o} />
              <Stop offset="30%" stopColor="rgb(251,113,133)" stopOpacity={0.4 * o} />
              <Stop offset="60%" stopColor="rgb(249,115,22)" stopOpacity={0.2 * o} />
              <Stop offset="100%" stopColor="rgb(244,114,182)" stopOpacity={0} />
            </RadialGradient>
            <RadialGradient id="orb3" cx="50%" cy="50%" rx="50%" ry="50%">
              <Stop offset="0%" stopColor="rgb(251,113,133)" stopOpacity={0.45 * o} />
              <Stop offset="25%" stopColor="rgb(236,72,153)" stopOpacity={0.35 * o} />
              <Stop offset="50%" stopColor="rgb(249,115,22)" stopOpacity={0.2 * o} />
              <Stop offset="100%" stopColor="rgb(251,113,133)" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Ellipse cx="30%" cy="15%" rx="55%" ry="45%" fill="url(#orb1)" />
          <Ellipse cx="80%" cy="35%" rx="50%" ry="55%" fill="url(#orb2)" />
          <Ellipse cx="50%" cy="90%" rx="55%" ry="40%" fill="url(#orb3)" />
        </Svg>
      </View>
    )
  }

  return (
    <View className="absolute inset-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
      <style dangerouslySetInnerHTML={{ __html: GRADIENT_CSS }} />
      <div
        style={{
          position: 'absolute',
          width: '80%',
          height: '110%',
          top: '-30%',
          left: '-10%',
          borderRadius: '50%',
          filter: 'blur(60px)',
          background: isDark
            ? 'radial-gradient(ellipse, rgba(96,165,250,0.2) 0%, rgba(147,197,253,0.12) 40%, transparent 70%)'
            : 'radial-gradient(ellipse, rgba(96,165,250,0.55) 0%, rgba(147,197,253,0.35) 40%, transparent 70%)',
          animation: 'lovable-drift 20s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: '70%',
          height: '130%',
          top: '-20%',
          right: '-15%',
          borderRadius: '50%',
          filter: 'blur(60px)',
          background: isDark
            ? 'radial-gradient(ellipse, rgba(244,114,182,0.22) 0%, rgba(251,113,133,0.18) 30%, rgba(249,115,22,0.12) 60%, transparent 80%)'
            : 'radial-gradient(ellipse, rgba(244,114,182,0.6) 0%, rgba(251,113,133,0.5) 30%, rgba(249,115,22,0.35) 60%, transparent 80%)',
          animation: 'lovable-drift-alt 18s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: '90%',
          height: '70%',
          bottom: '-25%',
          left: '5%',
          borderRadius: '50%',
          filter: 'blur(70px)',
          background: isDark
            ? 'radial-gradient(ellipse, rgba(251,113,133,0.2) 0%, rgba(236,72,153,0.15) 25%, rgba(249,115,22,0.1) 50%, transparent 75%)'
            : 'radial-gradient(ellipse, rgba(251,113,133,0.55) 0%, rgba(236,72,153,0.45) 25%, rgba(249,115,22,0.3) 50%, transparent 75%)',
          animation: 'lovable-drift 22s ease-in-out infinite reverse',
        }}
      />
    </View>
  )
})

/**
 * "Open Folder…" CTA for VS Code-style external projects. Only renders
 * when:
 *   1. `localMode` is true (we're running inside Shogo Desktop / a
 *      local-mode dev shell), AND
 *   2. The renderer is web (Electron's webContents or `bun dev:all`'s
 *      browser tab — anywhere `window` exists).
 *
 * The handler walks the user through:
 *   - Folder picker: Electron's native `shogoDesktop.pickFolders` IPC
 *     when present; otherwise the in-app `<FolderPickerModal>` (a
 *     server-side directory-listing picker, JupyterLab-style) used
 *     during `bun dev:all` where Electron isn't attached. The API
 *     validates every path either way (under `$HOME`, not a system
 *     root, realpath'd).
 *   - POST /from-folders, with the git-root walk-up prompt if the
 *     picked path is inside a `.git` repo.
 *   - Route to the new project page on success.
 */
const OpenFolderCta = memo(function OpenFolderCta({ visible }: { visible: boolean }) {
  const router = useRouter()
  const http = useDomainHttp()
  const activeWorkspace = useActiveWorkspace()
  const activeWorkspaceId: string | undefined = (activeWorkspace as { id?: string } | null)?.id
  const [isPicking, setIsPicking] = useState(false)
  // Modal open state for the in-app folder picker (web fallback when
  // Electron's native dialog isn't available). Promise resolver lives
  // in a ref so the same modal instance can power any number of
  // open-folder sessions without re-mounting.
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerResolveRef = useRef<((p: string | null) => void) | null>(null)

  if (!visible) return null
  // Native folder picker is only present when Electron's preload has
  // injected `window.shogoDesktop.pickFolders`. The web-only File System
  // Access API doesn't expose absolute paths to JS, so it can't replace
  // it. When running `bun dev:all` (web bundle in a regular browser, no
  // Electron) we drop into the in-app `<FolderPickerModal>` — a
  // server-side directory-listing picker. The API validates every path
  // (under `$HOME`, not a system root, realpath'd) so the modal can
  // never surface anything POST /from-folders wouldn't accept.
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  const desktop = (window as any).shogoDesktop as
    | { pickFolders?: (opts?: { multi?: boolean }) => Promise<any> }
    | undefined
  const hasNativePicker = Boolean(desktop?.pickFolders)

  const pickViaModal = (): Promise<{ ok: true; paths: string[] } | { ok: false }> => {
    return new Promise((resolve) => {
      pickerResolveRef.current = (path) => {
        pickerResolveRef.current = null
        setPickerOpen(false)
        if (!path) resolve({ ok: false })
        else resolve({ ok: true, paths: [path] })
      }
      setPickerOpen(true)
    })
  }

  const handleOpenFolder = async () => {
    if (isPicking) return
    setIsPicking(true)
    try {
      const picked = hasNativePicker
        ? await desktop!.pickFolders!({ multi: false })
        : await pickViaModal()
      if (!picked?.ok || !Array.isArray(picked.paths) || picked.paths.length === 0) {
        return
      }
      // First attempt — no git-root opinion yet.
      let res = (await api.createLocalFolderProject(http, {
        paths: picked.paths,
        workspaceId: activeWorkspaceId,
      })) as any

      if (res?.needsGitRootChoice) {
        // Confirm with the user inside an Alert. We can't use the same
        // modal stack as ProjectExportModal because we'd have to wire
        // it into the home page; an Alert is the right weight for a
        // yes/no question, and matches how aider's CLI prompts you.
        const choice = await new Promise<'parent' | 'subfolder' | null>((resolve) => {
          Alert.alert(
            'Use parent repo?',
            `The folder you picked is inside a git repo:\n\n${res.gitRoot}\n\n` +
              `Opening the repo root gives the agent context across the whole project. ` +
              `Or stick with the subfolder you picked: ${res.picked}.`,
            [
              { text: 'Use repo root', onPress: () => resolve('parent') },
              { text: 'Keep subfolder', onPress: () => resolve('subfolder') },
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
            ],
            { cancelable: true, onDismiss: () => resolve(null) },
          )
        })
        if (!choice) return
        res = (await api.createLocalFolderProject(http, {
          paths: picked.paths,
          workspaceId: activeWorkspaceId,
          acceptedGitRoot: choice === 'parent',
        })) as any
      }

      const project = res?.project as { id?: string } | undefined
      if (project?.id) {
        router.push({ pathname: '/(app)/projects/[id]' as any, params: { id: project.id } })
      } else if (res?.error || res?.message) {
        Alert.alert('Could not open folder', String(res.message ?? res.error))
      }
    } catch (err: any) {
      console.error('[OpenFolderCta] open folder failed:', err)
      Alert.alert('Could not open folder', err?.message ?? 'Unknown error')
    } finally {
      setIsPicking(false)
    }
  }

  return (
    <View className="mt-4 flex-row items-center justify-center">
      <Pressable
        onPress={handleOpenFolder}
        disabled={isPicking}
        className={cn(
          'flex-row items-center gap-2 rounded-full px-4 py-2 border border-border',
          isPicking ? 'opacity-60' : 'active:opacity-80',
        )}
      >
        {isPicking ? <ActivityIndicator size="small" /> : null}
        <Text className="text-xs font-medium text-foreground">Open folder…</Text>
      </Pressable>
      {/* In-app folder picker for the web/dev path. Mounted once and
          driven by `pickViaModal` above so a single instance handles
          repeated open-folder gestures. Native Electron skips this
          modal entirely — `hasNativePicker` short-circuits before we
          ever set `pickerOpen`. */}
      <FolderPickerModal
        open={pickerOpen}
        onSelect={(p) => pickerResolveRef.current?.(p)}
        onClose={() => pickerResolveRef.current?.(null)}
      />
    </View>
  )
})

// Tab descriptors are static — keep them at module scope so the array
// reference doesn't churn on every render of HomeScreen.
//
// The "Templates" tab was removed when built-in templates were folded
// into the marketplace; the surface the user sees is now exclusively
// their own projects, plus shared. Marketplace browsing happens on
// the dedicated `/marketplace` route and via the marketing-site
// `pending_template_id` deep-link below.
const TAB_ITEMS = [
  { key: 'projects' as const, label: 'My projects' },
  { key: 'shared' as const, label: 'Shared with me' },
]

// Static style fragments. The composer-wrapper variants below are a
// per-theme ✕ per-platform decision tree, so we precompute the four
// possibilities once and pick by index instead of building a new object
// literal on every render.
const TAB_BAR_CONTENT_STYLE = { alignItems: 'center' as const, gap: 2 }
const SCROLL_VIEW_CONTENT_STYLE = { flexGrow: 1 }
const COMPOSER_WRAPPER_NATIVE = { maxWidth: 680 }
const COMPOSER_WRAPPER_WEB_LIGHT = {
  maxWidth: 680,
  boxShadow:
    '0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)',
} as const
const COMPOSER_WRAPPER_WEB_DARK = {
  maxWidth: 680,
  boxShadow:
    '0 4px 24px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.3)',
} as const

const HomeScreen = observer(function HomeScreen() {
  const router = useRouter()
  const { user, isAuthenticated } = useAuth()
  const { localMode } = usePlatformConfig()
  const posthog = usePostHogSafe()
  const projects = useProjectCollection()
  const workspaces = useWorkspaceCollection()
  const membersColl = useMemberCollection()
  const http = useDomainHttp()
  const actions = useDomainActions()
  const isDark = useDarkMode()
  const { width: screenWidth } = useWindowDimensions()
  const isMobile = screenWidth < 640
  const gridColumns = screenWidth < 640 ? 2 : screenWidth < 1024 ? 2 : 3

  const [prompt, setPrompt] = useState('')
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('agent')
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_FREE)
  const [isCreating, setIsCreating] = useState(false)

  /**
   * Draft project the homepage opens behind the scenes as soon as the
   * user starts composing (typing or tapping the mic for Shogo Mode).
   * Reused by both submit and the Shogo voice entry point so we never
   * create two projects for one creation gesture, and so a runtime pod
   * is being warmed while the user is still composing.
   */
  type HomeDraft = { projectId: string; chatSessionId: string }
  const draftRef = useRef<HomeDraft | null>(null)
  const draftPromiseRef = useRef<Promise<HomeDraft | null> | null>(null)
  const draftPrewarmedRef = useRef<Set<string>>(new Set())
  const draftTypeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  // APP_MODE_DISABLED: homeAppTemplates state removed
  const [activeTab, setActiveTab] = useState<'projects' | 'shared'>('projects')

  const [workspaceError, setWorkspaceError] = useState(false)

  useEffect(() => {
    void loadInteractionModePreference().then((stored) => {
      if (stored) setInteractionMode(stored)
    })
  }, [])

  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false

    async function loadData(attempt = 0) {
      setWorkspaceError(false)
      const results = await Promise.allSettled([
        projects.loadAll(),
        workspaces.loadAll(),
        user?.id ? membersColl.loadAll({ userId: user.id }) : Promise.resolve(),
      ])

      const hasTransientFailure = results.some(
        (r) => r.status === 'rejected' && (r.reason?.status === 401 || r.reason?.status === 503),
      )

      if (hasTransientFailure && attempt < 2 && !cancelled) {
        await new Promise((r) => setTimeout(r, 1500))
        if (!cancelled) return loadData(attempt + 1)
        return
      }

      if (results[0].status === 'rejected')
        console.error('[Home] Failed to load projects:', results[0].reason)
      if (results[1].status === 'rejected') {
        console.error('[Home] Failed to load workspaces:', results[1].reason)
        setWorkspaceError(true)
      }
      if (results[2].status === 'rejected')
        console.error('[Home] Failed to load memberships:', results[2].reason)
    }

    loadData()

    return () => { cancelled = true }
  }, [isAuthenticated, user?.id])

  const currentWorkspace = useActiveWorkspace()
  const billingData = useBillingData(currentWorkspace?.id)
  const hasAdvancedModelAccess = billingData.hasAdvancedModelAccess

  useEffect(() => {
    loadModelPreference().then((stored) => {
      if (stored) {
        setSelectedModel(stored)
      } else if (hasAdvancedModelAccess) {
        setSelectedModel(DEFAULT_MODEL_PRO)
      }
    })
  }, [hasAdvancedModelAccess])

  // Deep-link: auto-install a marketplace listing referred from the
  // marketing site. The storage slot is still named
  // `pending_template_id` so existing marketing-site links keep
  // working — the slug matches the legacy template id 1:1 after the
  // templates → marketplace migration. We always fetch the listing
  // detail directly via `/api/marketplace/:slug` (the homepage no
  // longer pre-loads a featured rail to look up against).
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const pendingSlug = safeGetItem('pending_template_id')
    if (!pendingSlug || !currentWorkspace?.id || !user?.id) return

    http.get<{ listing?: HomeListing }>(`/api/marketplace/${encodeURIComponent(pendingSlug)}`)
      .then((res) => {
        safeRemoveItem('pending_template_id')
        const found = res.data?.listing
        if (found) handleTemplatePress(found)
      })
      .catch(() => {
        safeRemoveItem('pending_template_id')
      })
  }, [currentWorkspace?.id, user?.id])

  // APP_MODE_DISABLED: pending_app_template deep-link removed

  const myProjects = useMemo((): IProject[] => {
    try {
      const all = projects?.all
      return [...(Array.isArray(all) ? all : [])]
        .sort((a: any, b: any) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
          return bTime - aTime
        })
    } catch {
      return []
    }
  }, [projects?.all])

  const sharedProjects = useMemo((): IProject[] => {
    if (!user?.id) return []
    try {
      const userMembers = membersColl.all.filter((m: IMember) => m.userId === user.id)
      const sharedWsIds = new Set(
        workspaces.all
          .filter((ws: IWorkspace) => {
            const membership = userMembers.find((m: IMember) => m.workspaceId === ws.id)
            return membership && membership.role !== 'owner'
          })
          .map((ws: IWorkspace) => ws.id)
      )
      return [...(projects?.all ?? [])]
        .filter((p) => sharedWsIds.has(p.workspaceId))
        .sort((a, b) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
          return bTime - aTime
        })
    } catch {
      return []
    }
  }, [user?.id, projects?.all, membersColl.all, workspaces.all])

  const firstName = useMemo(() => {
    const name = user?.name || 'there'
    return name.split(' ')[0] || 'there'
  }, [user?.name])

  const handleHomeInteractionModeChange = useCallback((mode: InteractionMode) => {
    setInteractionMode(mode)
    void saveInteractionModePreference(mode)
  }, [])

  const handleHomeModelChange = useCallback((modelId: string) => {
    setSelectedModel(modelId)
    void saveModelPreference(modelId)
  }, [])

  const homeComposerPlaceholder =
    interactionMode === 'plan'
      ? 'Describe what you want to plan...'
      : interactionMode === 'ask'
        ? 'Ask a question...'
        : undefined

  /**
   * Single-flight: create the draft project + chat session for the home
   * composer, kick off a runtime prewarm, and return them. Concurrent
   * callers (typing debounce + submit + mic) all join the same in-flight
   * promise so we never duplicate creation. Once a draft exists, future
   * calls resolve to the same draft until it has been consumed by a
   * navigation away from the home screen.
   */
  const ensureDraftProject = useCallback(async (): Promise<HomeDraft | null> => {
    if (draftRef.current) return draftRef.current
    if (draftPromiseRef.current) return draftPromiseRef.current
    if (!user?.id || !currentWorkspace?.id) return null

    const promise = (async (): Promise<HomeDraft | null> => {
      try {
        const newProject = await actions.createProject(
          'New Project',
          currentWorkspace.id,
          undefined,
          user.id,
        )
        // The legacy createProject signature took a techStackId hint
        // ('react-app'). After the templates → marketplace consolidation
        // createProject builds plain blank projects only — the
        // marketplace install path is the source of tech-stack-aware
        // seeding. The runtime defaults to react-app for projects with
        // no settings.techStackId, matching the old fallback.
        const chatSession = await actions.createChatSession({
          inferredName: 'Untitled',
          contextType: 'project',
          contextId: newProject.id,
        })
        const draft: HomeDraft = {
          projectId: newProject.id,
          chatSessionId: chatSession.id,
        }
        draftRef.current = draft

        // Fire-and-forget runtime prewarm. The API returns 202 and warms
        // the warm-pool / cold-start in the background so the pod is
        // claimed/assigned by the time the user navigates into the
        // project. Idempotent — we still guard against duplicate calls
        // per project id locally.
        if (!draftPrewarmedRef.current.has(draft.projectId)) {
          draftPrewarmedRef.current.add(draft.projectId)
          void api.prewarmProjectRuntime(http, draft.projectId)
        }

        return draft
      } catch (err: any) {
        console.warn('[Home] ensureDraftProject failed:', err?.message ?? err)
        return null
      } finally {
        draftPromiseRef.current = null
      }
    })()

    draftPromiseRef.current = promise
    return promise
  }, [actions, currentWorkspace?.id, http, user?.id])

  /** Wrap `setPrompt` so the homepage starts warming as soon as there's real input. */
  const handlePromptChange = useCallback((next: string) => {
    setPrompt(next)
    if (next.trim().length < 3) return
    if (draftRef.current || draftPromiseRef.current) return
    if (draftTypeTimerRef.current) clearTimeout(draftTypeTimerRef.current)
    // Tiny debounce so a single keystroke doesn't trigger creation, but
    // we still kick off well before submit so warm-pool claim has time
    // to land.
    draftTypeTimerRef.current = setTimeout(() => {
      draftTypeTimerRef.current = null
      void ensureDraftProject()
    }, 250)
  }, [ensureDraftProject])

  useEffect(() => {
    return () => {
      if (draftTypeTimerRef.current) clearTimeout(draftTypeTimerRef.current)
    }
  }, [])

  const createProjectFromPrompt = useCallback(async (
    text: string,
    files?: FileAttachment[],
    submissionInteractionMode: InteractionMode = interactionMode,
  ) => {
    if (!text.trim() || !user?.id || !currentWorkspace?.id) return

    setIsCreating(true)
    try {
      const projectName = generateProjectNameFromPrompt(text)

      // Reuse the draft created by typing/mic if available; otherwise
      // create one synchronously here. This guarantees we never create
      // two projects for one creation gesture.
      let draft = draftRef.current
      if (!draft) {
        try {
          draft = await ensureDraftProject()
        } catch {
          draft = null
        }
      }
      if (!draft) {
        try {
          const newProject = await actions.createProject(
            projectName,
            currentWorkspace.id,
            undefined,
            user.id,
          )
          const chatSession = await actions.createChatSession({
            inferredName: 'Untitled',
            contextType: 'project',
            contextId: newProject.id,
          })
          draft = { projectId: newProject.id, chatSessionId: chatSession.id }
          draftRef.current = draft
          if (!draftPrewarmedRef.current.has(draft.projectId)) {
            draftPrewarmedRef.current.add(draft.projectId)
            void api.prewarmProjectRuntime(http, draft.projectId)
          }
        } catch (err: any) {
          const detail = err?.message || err?.details?.error?.message || String(err)
          console.error('[Home] Failed to create project:', detail, err)
          Alert.alert('Error', `Failed to create project: ${detail}`)
          return
        }
      }

      // Update the draft project's name from the heuristic now that we
      // actually have prompt text. Fire-and-forget — the AI rename below
      // may overwrite this shortly.
      actions.updateProject(draft.projectId, { name: projectName }).catch(() => {})

      trackEvent(posthog, EVENTS.PROJECT_CREATED, { source: 'prompt' })

      if (files && files.length > 0) {
        setPendingFiles(files)
      }
      projects.loadAll()
      const consumed = draft
      // Consume the draft so subsequent home interactions create a new one.
      draftRef.current = null
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: consumed.projectId,
          chatSessionId: consumed.chatSessionId,
          initialMessage: text,
          initialInteractionMode: submissionInteractionMode,
        },
      } as any)

      // Fire-and-forget: replace heuristic name with AI-generated name
      const pid = consumed.projectId
      const sid = consumed.chatSessionId
      api.generateProjectName(http, text, currentWorkspace.id).then(({ name, description }) => {
        if (name && name !== projectName) {
          actions.updateProject(pid, { name, description: description || undefined })
          actions.updateChatSession(sid, { inferredName: name })
        }
      }).catch((err) => {
        console.warn('[Home] AI project name generation failed, keeping heuristic name:', err)
      })
    } finally {
      setIsCreating(false)
    }
  }, [
    actions,
    currentWorkspace?.id,
    ensureDraftProject,
    http,
    interactionMode,
    posthog,
    projects,
    router,
    user?.id,
  ])

  /**
   * Homepage mic entry point — clicking the microphone is intentionally
   * NOT generic dictation. It opens Shogo Mode for a brand-new project:
   * we ensure a draft project exists (creating + prewarming if needed),
   * then navigate into the project with route params that tell the
   * project layout to flip Shogo Mode on and auto-start the voice
   * session.
   */
  const handleStartVoiceProjectCreation = useCallback(async () => {
    if (Platform.OS !== 'web') return
    if (isCreating) return
    if (!user?.id || !currentWorkspace?.id) return

    setIsCreating(true)
    try {
      let draft = draftRef.current
      if (!draft) {
        draft = await ensureDraftProject()
      }
      if (!draft) return

      trackEvent(posthog, EVENTS.PROJECT_CREATED, { source: 'voice' })
      projects.loadAll()
      const consumed = draft
      draftRef.current = null
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: consumed.projectId,
          chatSessionId: consumed.chatSessionId,
          initialInteractionMode: interactionMode,
          startShogoMode: '1',
          autoStartVoice: '1',
        },
      } as any)
    } finally {
      setIsCreating(false)
    }
  }, [
    currentWorkspace?.id,
    ensureDraftProject,
    interactionMode,
    isCreating,
    posthog,
    projects,
    router,
    user?.id,
  ])

  const handlePromptSubmit = useCallback(
    (
      text: string,
      files?: FileAttachment[],
      modeOverride?: InteractionMode,
    ): void | false => {
      const submissionInteractionMode = modeOverride ?? interactionMode
      void createProjectFromPrompt(text, files, submissionInteractionMode)
    },
    [createProjectFromPrompt, interactionMode],
  )

  const handleTemplatePress = useCallback(async (listing: HomeListing) => {
    if (!user?.id || !currentWorkspace?.id) {
      Alert.alert('Not ready', 'Still loading your workspace. Please try again in a moment.')
      return
    }
    setLoadingTemplate(listing.slug)
    try {
      const installed = await actions.installListing(listing.slug, currentWorkspace.id)
      if (!installed?.projectId) {
        throw new Error('Install did not return a project id')
      }
      const chatSession = await actions.createChatSession({
        inferredName: 'Untitled',
        contextType: 'project',
        contextId: installed.projectId,
      })
      trackEvent(posthog, EVENTS.PROJECT_CREATED, {
        source: 'marketplace',
        listing_slug: listing.slug,
        listing_title: listing.title,
      })

      const onboardingMessage = getOnboardingMessage(listing.title, listing.slug)
      // Marketplace browse-card payload doesn't include integrations —
      // we let the project layout fetch them from /api/marketplace/:slug
      // when `showIntegrations=1` is set, so always pass it through and
      // let the layout decide whether to actually render the card.
      projects.loadAll()
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: installed.projectId,
          chatSessionId: chatSession.id,
          initialMessage: onboardingMessage,
          showIntegrations: '1',
        },
      } as any)
    } catch (error) {
      console.error('[Home] Failed to install marketplace listing:', error)
      Alert.alert('Error', 'Failed to install agent from marketplace')
    } finally {
      setLoadingTemplate(null)
    }
  }, [actions, user?.id, currentWorkspace?.id, projects, router, posthog])

  // APP_MODE_DISABLED: handleAppTemplatePress removed

  // Memoized style fragments. These only flip on screen-size or theme
  // boundaries, so caching them gives every memoized child the same
  // identity-equal style across renders driven by other state (input
  // value, mobx ticks, etc.).
  const heroOuterStyle = useMemo(
    () => ({ minHeight: isMobile ? 340 : 420 }),
    [isMobile],
  )
  const heroInnerStyle = useMemo(
    () => ({
      paddingHorizontal: isMobile ? 16 : 24,
      paddingTop: isMobile ? 48 : 64,
      paddingBottom: isMobile ? 32 : 48,
    }),
    [isMobile],
  )
  const heroTitleStyle = useMemo(
    () => ({
      fontSize: isMobile ? 26 : 36,
      lineHeight: isMobile ? 34 : 44,
      letterSpacing: -0.5,
    }),
    [isMobile],
  )
  const heroSubtitleStyle = useMemo(
    () => ({ fontSize: isMobile ? 14 : 16 }),
    [isMobile],
  )
  const composerWrapperStyle =
    Platform.OS === 'web'
      ? isDark
        ? COMPOSER_WRAPPER_WEB_DARK
        : COMPOSER_WRAPPER_WEB_LIGHT
      : COMPOSER_WRAPPER_NATIVE
  const bottomSectionStyle = useMemo(
    () => ({
      marginTop: -24,
      paddingTop: 20,
      marginLeft: isMobile ? 8 : 20,
      marginRight: isMobile ? 8 : 20,
    }),
    [isMobile],
  )
  const tabBarRowStyle = useMemo(
    () => ({ paddingHorizontal: isMobile ? 12 : 24, gap: 4 }),
    [isMobile],
  )
  const tabContentPaddingStyle = useMemo(
    () => ({ paddingHorizontal: isMobile ? 12 : 24, paddingBottom: 40 }),
    [isMobile],
  )
  const gridContainerStyle = useMemo(
    () =>
      Platform.OS === 'web'
        ? ({
            display: 'grid' as any,
            gridTemplateColumns: `repeat(${gridColumns}, 1fr)`,
            gap: isMobile ? 10 : 16,
            maxWidth: 1100,
            marginHorizontal: 'auto',
          } as any)
        : {},
    [gridColumns, isMobile],
  )

  if (!isAuthenticated) {
    if (localMode) {
      router.replace('/')
      return null
    }
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-lg font-semibold mb-2 text-foreground">Welcome to Shogo</Text>
          <Text className="text-center mb-6 text-muted-foreground">
            Build and run AI agents from your phone. Sign in to see your projects.
          </Text>
          <Button size="lg" onPress={() => router.push('/(auth)/sign-in')}>
            Sign In to Get Started
          </Button>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={SCROLL_VIEW_CONTENT_STYLE}>
        {/* Hero section with gradient */}
        <View className="relative" style={heroOuterStyle}>
          <LovableGradient isDark={isDark} />

          <View
            className="relative items-center justify-center"
            style={heroInnerStyle}
          >
            <Text
              className="text-center font-bold mb-2 text-foreground"
              style={heroTitleStyle}
            >
              What's on your mind, {firstName}?
            </Text>
            <Text
              className="text-center mb-8 text-muted-foreground"
              style={heroSubtitleStyle}
            >
              Build agents by chatting with AI
            </Text>

            <View
              className="w-full rounded-2xl"
              style={composerWrapperStyle}
            >
              <CompactChatInput
                onSubmit={handlePromptSubmit}
                isLoading={isCreating}
                placeholder={homeComposerPlaceholder}
                agentPlaceholderActive={interactionMode === 'agent'}
                value={prompt}
                onChange={handlePromptChange}
                interactionMode={interactionMode}
                onInteractionModeChange={handleHomeInteractionModeChange}
                selectedModel={selectedModel}
                onModelChange={handleHomeModelChange}
                isPro={hasAdvancedModelAccess}
                onUpgradeClick={() => router.push('/billing')}
                onStartVoiceProjectCreation={
                  Platform.OS === 'web' ? handleStartVoiceProjectCreation : undefined
                }
              />
            </View>

            {/* "Open Folder…" — desktop local-mode CTA for VS Code-style
                external projects. Temporarily hidden on the home page
                while the chat-on-external-folder flow is being
                stabilised (canvas timeout + chat send hangs are still
                being investigated). The picker itself, the
                `POST /from-folders` route, and the project-level
                Folders panel remain wired up; flip this back to
                `<OpenFolderCta visible={localMode} />` when ready. */}
            <OpenFolderCta visible={false} />
          </View>
        </View>

        {/* Bottom section: tab bar + template cards */}
        <View
          className="flex-1 rounded-t-3xl bg-card border-t border-border"
          style={bottomSectionStyle}
        >
          <View
            className="flex-row items-center mb-5"
            style={tabBarRowStyle}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={TAB_BAR_CONTENT_STYLE}
              className="flex-1"
            >
              {TAB_ITEMS.map((tab) => (
                <Pressable
                  key={tab.key}
                  onPress={() => setActiveTab(tab.key)}
                  className={cn(
                    'px-3 py-2 rounded-lg',
                    activeTab === tab.key && 'bg-muted',
                  )}
                >
                  <Text
                    className={cn(
                      'text-[13px]',
                      activeTab === tab.key
                        ? 'text-foreground font-semibold'
                        : 'text-muted-foreground'
                    )}
                    numberOfLines={1}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {activeTab === 'shared' && (
              <Pressable
                onPress={() => router.push('/(app)/shared' as any)}
                className="flex-row items-center gap-1 active:opacity-70 flex-shrink-0"
              >
                <Text className="text-[13px] font-medium text-foreground">
                  View all
                </Text>
                <ArrowRight size={14} className="text-foreground" />
              </Pressable>
            )}
          </View>

          <View style={tabContentPaddingStyle}>
            {activeTab === 'projects' && (
              myProjects.length > 0 ? (
                <View className="gap-3" style={gridContainerStyle}>
                  {myProjects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      name={String(project.name || 'Untitled')}
                      description={typeof project.description === 'string' ? project.description : undefined}
                      updatedAt={project.updatedAt}
                      createdAt={project.createdAt}
                      onPress={() => router.push(`/(app)/projects/${project.id}`)}
                      isDark={isDark}
                      compact={isMobile}
                    />
                  ))}
                </View>
              ) : (
                <View className="items-center py-12">
                  <Text className="text-muted-foreground text-sm">No projects yet — create one above!</Text>
                </View>
              )
            )}

            {activeTab === 'shared' && (
              sharedProjects.length > 0 ? (
                <View className="gap-3" style={gridContainerStyle}>
                  {sharedProjects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      name={String(project.name || 'Untitled')}
                      description={typeof project.description === 'string' ? project.description : undefined}
                      updatedAt={project.updatedAt}
                      createdAt={project.createdAt}
                      onPress={() => router.push(`/(app)/projects/${project.id}`)}
                      isDark={isDark}
                      badge="Shared"
                      compact={isMobile}
                    />
                  ))}
                </View>
              ) : (
                <View className="items-center py-12">
                  <Text className="text-muted-foreground text-sm">No shared projects</Text>
                </View>
              )
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  )
})

export default HomeScreen
