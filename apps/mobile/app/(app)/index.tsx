// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react'
import {
  View,
  Text,
  Platform,
  Alert,
  useWindowDimensions,
} from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import Svg, { Defs, RadialGradient, Stop, Ellipse } from 'react-native-svg'
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
import { CompactChatInput } from '../../components/chat/CompactChatInput'
import type { FileAttachment, InteractionMode } from '../../components/chat/ChatInput'
import { DEFAULT_MODEL_PRO, DEFAULT_MODEL_FREE } from '../../components/chat/ChatInput'
import {
  loadInteractionModePreference,
  saveInteractionModePreference,
} from '../../lib/interaction-mode-preference'
import { loadModelPreference, saveModelPreference } from '../../lib/agent-mode-preference'
import { useReconcileStaleModelSelection } from '../../lib/visible-models'
import { setPendingFiles } from '../../lib/pending-image-store'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { workspaceProjectFilter } from '../../lib/project-load'
import { useBillingData } from '@shogo/shared-app/hooks'
import { usePlatformConfig, isWorkspaceRuntimeEnabled } from '../../lib/platform-config'
import { api, getOnboardingMessage } from '../../lib/api'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { safeGetItem, safeRemoveItem } from '../../lib/safe-storage'
import { getPendingLicenseCode, clearPendingLicenseCode } from '../../lib/pending-license'
import type { AgentTileListing } from '../../components/marketplace/AgentTile'
import { ProjectSourceMenu } from '../../components/project/ProjectSourceMenu'
import { TechStackPicker } from '../../components/chat/TechStackPicker'

/**
 * Default tech stack for blank projects created from the home composer.
 * Mirrors the agent-runtime fallback (`packages/agent-runtime/src/server.ts`),
 * so the persisted `settings.techStackId` matches what the workspace seeds.
 */
const DEFAULT_TECH_STACK_ID = 'react-app'

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

// The home-page "Open Folder…" pill was consolidated into the composer's
// `ProjectSourceMenu` chip. The folder-pick → /from-folders → git-root
// walk-up flow now lives in `useOpenLocalFolder`
// (apps/mobile/components/project/useOpenLocalFolder.ts), shared with
// the `/projects` page's "New project" menu so both surfaces stay in sync.

// Static style fragments. The composer-wrapper variants below are a
// per-theme ✕ per-platform decision tree, so we precompute the four
// possibilities once and pick by index instead of building a new object
// literal on every render.
const COMPOSER_WRAPPER_NATIVE = { maxWidth: 680 }
const CONTENT_MAX_WIDTH = { maxWidth: 680 } as const
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
  const { localMode, features } = usePlatformConfig()
  const posthog = usePostHogSafe()
  const projects = useProjectCollection()
  const workspaces = useWorkspaceCollection()
  const membersColl = useMemberCollection()
  const http = useDomainHttp()
  const actions = useDomainActions()
  const isDark = useDarkMode()
  const { width: screenWidth } = useWindowDimensions()
  const isMobile = screenWidth < 640

  const [prompt, setPrompt] = useState('')
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('agent')
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL_FREE)
  // Gate stale-selection reconciliation until the persisted preference has
  // loaded. Otherwise the reconciler runs against the initial slug default
  // (which isn't a catalog UUID id), resets to Auto, and persists that — which
  // clobbers the user's saved choice on every cold load.
  const [modelPrefLoaded, setModelPrefLoaded] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  // Tech stack chosen in the composer toolbar. Threaded into createProject so
  // the new project persists settings.techStackId (the runtime defaults to
  // react-app for absent values, so we record that same default here).
  const [techStackId, setTechStackId] = useState<string>(DEFAULT_TECH_STACK_ID)
  const techStackIdRef = useRef(techStackId)
  useEffect(() => {
    techStackIdRef.current = techStackId
  }, [techStackId])

  /**
   * Draft project the homepage opens behind the scenes for a creation
   * gesture (pressing Send or tapping the mic for EZ Mode). It is NOT
   * created while the user is merely typing — see `handlePromptChange`.
   * Reused by both submit and the Shogo voice entry point so we never
   * create two projects for one creation gesture.
   */
  type HomeDraft = {
    projectId: string
    chatSessionId: string
    /**
     * Whether `chatSessionId` is a workspace-scoped session (the project is
     * attached to it) chatting against the merged-root runtime, or a legacy
     * per-project session. Drives the route param + ChatPanel scope.
     */
    chatScope: 'project' | 'workspace'
  }
  const draftRef = useRef<HomeDraft | null>(null)
  const draftPromiseRef = useRef<Promise<HomeDraft | null> | null>(null)
  const draftPrewarmedRef = useRef<Set<string>>(new Set())
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  // APP_MODE_DISABLED: homeAppTemplates state removed

  const [workspaceError, setWorkspaceError] = useState(false)

  useEffect(() => {
    void loadInteractionModePreference().then((stored) => {
      if (stored) setInteractionMode(stored)
    })
  }, [])

  const currentWorkspace = useActiveWorkspace()

  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false

    async function loadData(attempt = 0) {
      setWorkspaceError(false)
      // Use the active workspace (which falls back to the first workspace
      // once `workspaces.loadAll()` has resolved). Relying on
      // `getActiveWorkspaceId()` alone breaks the first ever load because
      // nothing has been persisted to storage yet — the effect re-runs
      // when `currentWorkspace?.id` changes, so this also covers the
      // post-load case.
      const projectFilter = workspaceProjectFilter(currentWorkspace?.id)
      const results = await Promise.allSettled([
        projectFilter ? projects.loadAll(projectFilter) : Promise.resolve(),
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
  }, [isAuthenticated, user?.id, currentWorkspace?.id])
  const billingData = useBillingData(currentWorkspace?.id)
  const hasAdvancedModelAccess = billingData.hasAdvancedModelAccess

  useEffect(() => {
    loadModelPreference().then((stored) => {
      if (stored) {
        setSelectedModel(stored)
      } else if (hasAdvancedModelAccess) {
        setSelectedModel(DEFAULT_MODEL_PRO)
      }
      setModelPrefLoaded(true)
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

  // Deep-link: a non-iOS license-key redeem link stashed before
  // sign-up/onboarding. iOS upgrades must use App Store In-App Purchase only.
  useEffect(() => {
    if (Platform.OS === 'ios' || !currentWorkspace?.id || !user?.id) return
    const code = getPendingLicenseCode()
    if (!code) return
    clearPendingLicenseCode()
    router.replace({ pathname: '/(app)/billing', params: { redeem: code } } as any)
  }, [currentWorkspace?.id, user?.id, router])

  // APP_MODE_DISABLED: pending_app_template deep-link removed

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

  // Reset a pre-UUID stored selection (an old slug that's now only a server
  // alias, so the picker can't label it) to the tier default once the catalog
  // loads.
  useReconcileStaleModelSelection(
    selectedModel,
    hasAdvancedModelAccess ? DEFAULT_MODEL_PRO : DEFAULT_MODEL_FREE,
    handleHomeModelChange,
    modelPrefLoaded,
  )

  const homeComposerPlaceholder =
    interactionMode === 'plan'
      ? 'Describe what you want to plan...'
      : interactionMode === 'ask'
        ? 'Ask a question...'
        : undefined

  /**
   * Create the chat session for a freshly-created home project. When the
   * workspace runtime is enabled (client + server agree), this is a
   * workspace-scoped session with the project attached; otherwise it's the
   * legacy per-project session. Returns the draft descriptor.
   */
  const createHomeDraftSession = useCallback(
    async (projectId: string, workspaceId: string): Promise<HomeDraft> => {
      if (isWorkspaceRuntimeEnabled()) {
        const session = await api.createWorkspaceSession(http, workspaceId, {
          inferredName: 'Untitled',
          attachProjectIds: [projectId],
          attachMode: 'readwrite',
        })
        return { projectId, chatSessionId: session.id, chatScope: 'workspace' }
      }
      const chatSession = await actions.createChatSession({
        inferredName: 'Untitled',
        contextType: 'project',
        contextId: projectId,
      })
      return { projectId, chatSessionId: chatSession.id, chatScope: 'project' }
    },
    [actions, http],
  )

  /** Fire-and-forget warm the runtime that backs a draft (workspace or project). */
  const prewarmHomeDraft = useCallback(
    (draft: HomeDraft, workspaceId: string) => {
      if (draft.chatScope === 'workspace') {
        void api.prewarmWorkspaceRuntime(http, workspaceId, {
          sessionId: draft.chatSessionId,
          attachProjectIds: [draft.projectId],
        })
      } else {
        void api.prewarmProjectRuntime(http, draft.projectId)
      }
    },
    [http],
  )

  /**
   * Single-flight: create the draft project + chat session for the home
   * composer, kick off a runtime prewarm, and return them. Concurrent
   * callers (submit + mic) all join the same in-flight promise so we never
   * duplicate creation. Once a draft exists, future calls resolve to the
   * same draft until it has been consumed by a navigation away from the
   * home screen.
   */
  const ensureDraftProject = useCallback(async (): Promise<HomeDraft | null> => {
    if (draftRef.current) return draftRef.current
    if (draftPromiseRef.current) return draftPromiseRef.current
    if (!user?.id || !currentWorkspace?.id) return null

    const workspaceId = currentWorkspace.id
    const promise = (async (): Promise<HomeDraft | null> => {
      try {
        const newProject = await actions.createProject(
          'New Project',
          workspaceId,
          undefined,
          user.id,
          techStackIdRef.current,
        )
        // The stack chosen in the composer toolbar (defaults to
        // react-app) is persisted into settings.techStackId here so the
        // Configuration screen and the agent runtime agree on the stack.
        // Reading the ref keeps this single-flight draft in sync with a
        // last-moment stack change without re-running the callback.
        const draft = await createHomeDraftSession(newProject.id, workspaceId)
        draftRef.current = draft

        // Fire-and-forget runtime prewarm. The API returns 202 and warms
        // the warm-pool / cold-start in the background so the pod is
        // claimed/assigned by the time the user navigates into the
        // project. Idempotent — we still guard against duplicate calls
        // per project id locally.
        if (!draftPrewarmedRef.current.has(draft.projectId)) {
          draftPrewarmedRef.current.add(draft.projectId)
          prewarmHomeDraft(draft, workspaceId)
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
  }, [actions, createHomeDraftSession, currentWorkspace?.id, prewarmHomeDraft, user?.id])

  /**
   * Home composer input handler. Updates local state only — project and
   * chat-session creation is deferred to the actual creation gesture
   * (Send -> `createProjectFromPrompt`, mic -> `handleStartVoiceProjectCreation`)
   * so we never open a stray project while the user is still typing.
   */
  const handlePromptChange = useCallback((next: string) => {
    setPrompt(next)
  }, [])

  /**
   * Composer tech-stack chip handler. Updates local state (consumed at
   * creation time via `techStackIdRef`). A draft is only created on the
   * actual Send/mic gesture, so normally no project exists yet — but if a
   * draft was already minted (e.g. the mic prewarm path), patch its
   * settings.techStackId so it doesn't drift from the user's final choice.
   */
  const handleTechStackChange = useCallback((stackId: string) => {
    setTechStackId(stackId)
    const draft = draftRef.current
    if (draft) {
      // Settings is persisted as a JSON string (see updateProjectSettings in
      // the project layout); cast to bypass the object-typed `settings` field.
      const settingsStr = JSON.stringify({ activeMode: 'canvas', techStackId: stackId })
      actions
        .updateProject(draft.projectId, { settings: settingsStr as any })
        .catch(() => {})
    }
  }, [actions])

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
            techStackIdRef.current,
          )
          draft = await createHomeDraftSession(newProject.id, currentWorkspace.id)
          draftRef.current = draft
          if (!draftPrewarmedRef.current.has(draft.projectId)) {
            draftPrewarmedRef.current.add(draft.projectId)
            prewarmHomeDraft(draft, currentWorkspace.id)
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
      const filter = workspaceProjectFilter(currentWorkspace.id)
      if (filter) projects.loadAll(filter)
      const consumed = draft
      // Consume the draft so subsequent home interactions create a new one.
      draftRef.current = null
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: consumed.projectId,
          chatSessionId: consumed.chatSessionId,
          chatScope: consumed.chatScope,
          initialMessage: text,
          initialInteractionMode: submissionInteractionMode,
        },
      } as any)

      // Fire-and-forget: replace heuristic name with AI-generated name
      const pid = consumed.projectId
      const sid = consumed.chatSessionId
      const sidScope = consumed.chatScope
      api.generateProjectName(http, text, currentWorkspace.id).then(({ name, description }) => {
        if (name && name !== projectName) {
          actions.updateProject(pid, { name, description: description || undefined })
          // Only project-scoped sessions live in the local MST collection.
          // Workspace sessions are created server-side (api.createWorkspaceSession)
          // and aren't in `chatSessionCollection`, so updateChatSession would
          // throw "Item not found" — skip the local rename for them.
          if (sidScope === 'project') {
            actions.updateChatSession(sid, { inferredName: name })
          }
        }
      }).catch((err) => {
        console.warn('[Home] AI project name generation failed, keeping heuristic name:', err)
      })
    } finally {
      setIsCreating(false)
    }
  }, [
    actions,
    createHomeDraftSession,
    currentWorkspace?.id,
    ensureDraftProject,
    http,
    interactionMode,
    posthog,
    prewarmHomeDraft,
    projects,
    router,
    user?.id,
  ])

  /**
   * Homepage mic entry point — clicking the microphone is intentionally
   * NOT generic dictation. It opens EZ Mode for a brand-new project:
   * we ensure a draft project exists (creating + prewarming if needed),
   * then navigate into the project with route params that tell the
   * project layout to flip EZ Mode on and auto-start the voice
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
      const filter = workspaceProjectFilter(currentWorkspace.id)
      if (filter) projects.loadAll(filter)
      const consumed = draft
      draftRef.current = null
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: consumed.projectId,
          chatSessionId: consumed.chatSessionId,
          chatScope: consumed.chatScope,
          initialInteractionMode: interactionMode,
          startEzMode: '1',
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
      const filter = workspaceProjectFilter(currentWorkspace.id)
      if (filter) projects.loadAll(filter)
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

  // Unauthenticated local-mode sessions bounce back to the root router — but
  // NEVER navigate during render. Calling `router.replace()` in the render body
  // reschedules a navigation on every render while this screen is still mounted
  // (e.g. onboarding's `handleComplete` replaces to `/(app)` even when
  // `completeOnboarding` 401s, landing an unauthenticated user here), which
  // React surfaces as "Maximum update depth exceeded" (#185, Sentry
  // SHOGO-DESKTOP-3). Redirect once from an effect instead.
  useEffect(() => {
    if (!isAuthenticated && localMode) {
      router.replace('/')
    }
  }, [isAuthenticated, localMode, router])

  if (!isAuthenticated) {
    if (localMode) {
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
      <View className="relative flex-1 items-center justify-center px-4">
        <LovableGradient isDark={isDark} />

        <View
          className="relative w-full items-center justify-center"
          style={CONTENT_MAX_WIDTH}
        >
          <Text
            className="text-center font-bold mb-2 text-foreground"
            style={heroTitleStyle}
          >
            What's on your mind, {firstName}?
          </Text>

          <View className="w-full rounded-2xl" style={composerWrapperStyle}>
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
                Platform.OS === 'web' && features.ezMode
                  ? handleStartVoiceProjectCreation
                  : undefined
              }
              // Consolidated "where does this project come from?" entry
              // point. Sits at the leftmost edge of the toolbar so it
              // reads as "what am I creating?" before model + mode.
              // Selecting "Blank" is a no-op (the composer itself IS
              // the blank-project surface — the project is created on
              // Send, not while typing); "Open folder" / "Import" fire
              // their flows immediately and route into the resulting
              // project.
              leadingControls={
                <View className="flex-row items-center gap-1">
                  <ProjectSourceMenu
                    workspaceId={currentWorkspace?.id}
                    variant="chip"
                  />
                  {/* Tech stack for the project this composer will create.
                      Persisted into settings.techStackId on Send so the
                      Configuration screen reflects the real stack. */}
                  <TechStackPicker
                    value={techStackId}
                    onChange={handleTechStackChange}
                    disabled={isCreating}
                  />
                </View>
              }
            />
          </View>
        </View>
      </View>
    </View>
  )
})

export default HomeScreen
