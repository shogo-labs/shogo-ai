// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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
  PLAN_MODE_SUGGESTION_TIMEOUT_SECONDS,
  shouldSuggestPlanMode,
} from '../../components/chat/plan-mode-suggestion'
import { PlanModeSuggestion } from '../../components/chat/PlanModeSuggestion'
import {
  loadInteractionModePreference,
  saveInteractionModePreference,
} from '../../lib/interaction-mode-preference'
import { loadModelPreference, saveModelPreference } from '../../lib/agent-mode-preference'
import { setPendingFiles } from '../../lib/pending-image-store'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useTypingPlaceholder, AGENT_PLACEHOLDER_PREFIX } from '../../hooks/useTypingPlaceholder'
import { useBillingData } from '@shogo/shared-app/hooks'
import { usePlatformConfig } from '../../lib/platform-config'
import { api, getOnboardingMessage, type AgentTemplateSummary } from '../../lib/api'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { safeGetItem, safeRemoveItem } from '../../lib/safe-storage'
import { AgentTemplateGalleryCard } from '../../components/templates/agent-template-card'
// APP_MODE_DISABLED: import { AppTemplateGalleryCard } from '../../components/templates/app-template-card'

type AgentTemplate = AgentTemplateSummary

type PendingPlanModeSuggestionSubmission = {
  text: string
  files?: FileAttachment[]
}

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

function LovableGradient({ isDark }: { isDark: boolean }) {
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
}

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
  const [pendingPlanModeSuggestion, setPendingPlanModeSuggestion] =
    useState<PendingPlanModeSuggestionSubmission | null>(null)
  const [planModeSuggestionSecondsLeft, setPlanModeSuggestionSecondsLeft] = useState(
    PLAN_MODE_SUGGESTION_TIMEOUT_SECONDS
  )
  const pendingPlanModeSuggestionRef =
    useRef<PendingPlanModeSuggestionSubmission | null>(null)
  const planModeSuggestionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const planModeSuggestionIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

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
  const [homeTemplates, setHomeTemplates] = useState<AgentTemplate[]>([])
  // APP_MODE_DISABLED: homeAppTemplates state removed
  const [activeTab, setActiveTab] = useState<'projects' | 'shared' | 'templates'>('templates')

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

    async function fetchTemplates() {
      try {
        const agentData = await api.getAgentTemplates(http)
        const templates = Array.isArray(agentData) ? agentData : []
        setHomeTemplates(templates.slice(0, 6))
      } catch (err) {
        console.error('[Home] Failed to fetch templates:', err)
      }
    }
    fetchTemplates()

    return () => { cancelled = true }
  }, [isAuthenticated, user?.id, http])

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

  // Deep-link: auto-create project from pending template (website referral)
  useEffect(() => {
    if (Platform.OS !== 'web') return
    const pendingId = safeGetItem('pending_template_id')
    if (!pendingId || !currentWorkspace?.id || !user?.id) return
    if (homeTemplates.length === 0) return

    const template = homeTemplates.find(t => t.id === pendingId)
    if (!template) {
      // Template not in the first 6; fetch full list to find it
      api.getAgentTemplates(http).then((raw) => {
        const all = Array.isArray(raw) ? raw : []
        const found = all.find((t: AgentTemplate) => t.id === pendingId)
        if (found) {
          safeRemoveItem('pending_template_id')
          handleTemplatePress(found)
        } else {
          safeRemoveItem('pending_template_id')
        }
      }).catch(() => {
        safeRemoveItem('pending_template_id')
      })
      return
    }

    safeRemoveItem('pending_template_id')
    handleTemplatePress(template)
  }, [homeTemplates, currentWorkspace?.id, user?.id])

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

  const typingPlaceholder = useTypingPlaceholder(undefined, {
    enabled: interactionMode === 'agent' && !prompt,
  })

  const homeComposerPlaceholder =
    interactionMode === 'plan'
      ? 'Describe what you want to plan...'
      : interactionMode === 'ask'
        ? 'Ask a question...'
        : `${AGENT_PLACEHOLDER_PREFIX}${typingPlaceholder}`

  const clearPlanModeSuggestionTimers = useCallback(() => {
    if (planModeSuggestionTimeoutRef.current) {
      clearTimeout(planModeSuggestionTimeoutRef.current)
      planModeSuggestionTimeoutRef.current = null
    }
    if (planModeSuggestionIntervalRef.current) {
      clearInterval(planModeSuggestionIntervalRef.current)
      planModeSuggestionIntervalRef.current = null
    }
  }, [])

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
          undefined,
          undefined,
          'react-app',
        )
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
            undefined,
            undefined,
            'react-app',
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
      if (pendingPlanModeSuggestionRef.current && !modeOverride) {
        return false
      }

      const submissionInteractionMode = modeOverride ?? interactionMode
      if (
        !modeOverride &&
        submissionInteractionMode === 'agent' &&
        !isCreating &&
        !pendingPlanModeSuggestionRef.current &&
        shouldSuggestPlanMode(text)
      ) {
        clearPlanModeSuggestionTimers()
        const pending = { text, files }
        pendingPlanModeSuggestionRef.current = pending
        setPendingPlanModeSuggestion(pending)
        setPlanModeSuggestionSecondsLeft(PLAN_MODE_SUGGESTION_TIMEOUT_SECONDS)
        planModeSuggestionIntervalRef.current = setInterval(() => {
          setPlanModeSuggestionSecondsLeft((seconds) => Math.max(0, seconds - 1))
        }, 1000)
        planModeSuggestionTimeoutRef.current = setTimeout(() => {
          const pendingSubmission = pendingPlanModeSuggestionRef.current
          if (!pendingSubmission) return
          clearPlanModeSuggestionTimers()
          pendingPlanModeSuggestionRef.current = null
          setPendingPlanModeSuggestion(null)
          setPlanModeSuggestionSecondsLeft(PLAN_MODE_SUGGESTION_TIMEOUT_SECONDS)
          void createProjectFromPrompt(pendingSubmission.text, pendingSubmission.files, 'agent')
        }, PLAN_MODE_SUGGESTION_TIMEOUT_SECONDS * 1000)
        return false
      }

      void createProjectFromPrompt(text, files, submissionInteractionMode)
    },
    [
      clearPlanModeSuggestionTimers,
      createProjectFromPrompt,
      interactionMode,
      isCreating,
    ],
  )

  const handleResolvePlanModeSuggestion = useCallback(
    (targetMode: 'agent' | 'plan') => {
      const pending = pendingPlanModeSuggestionRef.current
      if (!pending) return

      clearPlanModeSuggestionTimers()
      pendingPlanModeSuggestionRef.current = null
      setPendingPlanModeSuggestion(null)
      setPlanModeSuggestionSecondsLeft(PLAN_MODE_SUGGESTION_TIMEOUT_SECONDS)

      handleHomeInteractionModeChange(targetMode)

      void handlePromptSubmit(pending.text, pending.files, targetMode)
    },
    [clearPlanModeSuggestionTimers, handleHomeInteractionModeChange, handlePromptSubmit],
  )

  const handleEditPlanModePrompt = useCallback(() => {
    const pending = pendingPlanModeSuggestionRef.current
    if (!pending) return

    clearPlanModeSuggestionTimers()
    pendingPlanModeSuggestionRef.current = null
    setPendingPlanModeSuggestion(null)
    setPlanModeSuggestionSecondsLeft(PLAN_MODE_SUGGESTION_TIMEOUT_SECONDS)
    setPrompt(pending.text)
  }, [clearPlanModeSuggestionTimers])

  useEffect(() => {
    return () => {
      clearPlanModeSuggestionTimers()
    }
  }, [clearPlanModeSuggestionTimers])

  const handleTemplatePress = useCallback(async (template: AgentTemplate) => {
    if (!user?.id || !currentWorkspace?.id) {
      Alert.alert('Not ready', 'Still loading your workspace. Please try again in a moment.')
      return
    }
    setLoadingTemplate(template.id)
    try {
      const newProject = await actions.createProject(
        template.name,
        currentWorkspace.id,
        template.description,
        user.id,
        'AGENT',
        template.id,
        template.techStack,
        template.settings,
      )
      const chatSession = await actions.createChatSession({
        inferredName: 'Untitled',
        contextType: 'project',
        contextId: newProject.id,
      })
      trackEvent(posthog, EVENTS.PROJECT_CREATED, {
        source: 'template',
        template_id: template.id,
        template_name: template.name,
      })

      const onboardingMessage = getOnboardingMessage(template.name, template.id)
      const hasIntegrations = Array.isArray(template.integrations) && template.integrations.length > 0
      projects.loadAll()
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: newProject.id,
          chatSessionId: chatSession.id,
          initialMessage: onboardingMessage,
          ...(hasIntegrations ? { showIntegrations: '1' } : {}),
        },
      } as any)
    } catch (error) {
      console.error('[Home] Failed to create project from template:', error)
      Alert.alert('Error', 'Failed to create project from template')
    } finally {
      setLoadingTemplate(null)
    }
  }, [actions, user?.id, currentWorkspace?.id, projects, router, posthog])

  // APP_MODE_DISABLED: handleAppTemplatePress removed

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

  const TAB_ITEMS = [
    { key: 'templates' as const, label: 'Templates' },
    { key: 'projects' as const, label: 'My projects' },
    { key: 'shared' as const, label: 'Shared with me' },
  ]

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
        {/* Hero section with gradient */}
        <View className="relative" style={{ minHeight: isMobile ? 340 : 420 }}>
          <LovableGradient isDark={isDark} />

          <View
            className="relative items-center justify-center"
            style={{
              paddingHorizontal: isMobile ? 16 : 24,
              paddingTop: isMobile ? 48 : 64,
              paddingBottom: isMobile ? 32 : 48,
            }}
          >
            <Text
              className="text-center font-bold mb-2 text-foreground"
              style={{
                fontSize: isMobile ? 26 : 36,
                lineHeight: isMobile ? 34 : 44,
                letterSpacing: -0.5,
              }}
            >
              What's on your mind, {firstName}?
            </Text>
            <Text
              className="text-center mb-8 text-muted-foreground"
              style={{ fontSize: isMobile ? 14 : 16 }}
            >
              Build agents by chatting with AI
            </Text>

            <View
              className="w-full rounded-2xl"
              style={Platform.OS === 'web' ? {
                maxWidth: 680,
                boxShadow: isDark
                  ? '0 4px 24px rgba(0,0,0,0.4), 0 1px 4px rgba(0,0,0,0.3)'
                  : '0 4px 24px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)',
              } as any : {
                maxWidth: 680,
              }}
            >
              {pendingPlanModeSuggestion && (
                <PlanModeSuggestion
                  secondsLeft={planModeSuggestionSecondsLeft}
                  onEditPrompt={handleEditPlanModePrompt}
                  onContinueInAgent={() => handleResolvePlanModeSuggestion('agent')}
                  onSwitchToPlan={() => handleResolvePlanModeSuggestion('plan')}
                />
              )}
              <CompactChatInput
                onSubmit={handlePromptSubmit}
                isLoading={isCreating || !!pendingPlanModeSuggestion}
                disabled={!!pendingPlanModeSuggestion}
                dimWhenDisabled={!pendingPlanModeSuggestion}
                placeholder={homeComposerPlaceholder}
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
          </View>
        </View>

        {/* Bottom section: tab bar + template cards */}
        <View
          className="flex-1 rounded-t-3xl bg-card border-t border-border"
          style={{
            marginTop: -24,
            paddingTop: 20,
            marginLeft: isMobile ? 8 : 20,
            marginRight: isMobile ? 8 : 20,
          }}
        >
          <View
            className="flex-row items-center mb-5"
            style={{ paddingHorizontal: isMobile ? 12 : 24, gap: 4 }}
          >
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ alignItems: 'center', gap: 2 }}
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

            {activeTab === 'templates' && (
              <Pressable
                onPress={() => router.push('/(app)/templates' as any)}
                className="flex-row items-center gap-1 active:opacity-70 flex-shrink-0"
              >
                <Text className="text-[13px] font-medium text-foreground">
                  Browse
                </Text>
                <ArrowRight size={14} className="text-foreground" />
              </Pressable>
            )}
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

          <View style={{ paddingHorizontal: isMobile ? 12 : 24, paddingBottom: 40 }}>
            {activeTab === 'templates' && (
              homeTemplates.length > 0 ? (
                <View
                  className="gap-3"
                  style={Platform.OS === 'web' ? {
                    display: 'grid' as any,
                    gridTemplateColumns: `repeat(${gridColumns}, 1fr)`,
                    gap: isMobile ? 10 : 16,
                    maxWidth: 1100,
                    marginHorizontal: 'auto',
                  } as any : {}}
                >
                  {homeTemplates.map((template) => (
                    <AgentTemplateGalleryCard
                      key={template.id}
                      template={template}
                      isLoading={loadingTemplate === template.id}
                      onPress={() => handleTemplatePress(template)}
                      isDark={isDark}
                      compact={isMobile}
                    />
                  ))}
                </View>
              ) : (
                <View className="items-center py-12">
                  <ActivityIndicator size="small" className="text-muted-foreground" />
                </View>
              )
            )}

            {activeTab === 'projects' && (
              myProjects.length > 0 ? (
                <View
                  className="gap-3"
                  style={Platform.OS === 'web' ? {
                    display: 'grid' as any,
                    gridTemplateColumns: `repeat(${gridColumns}, 1fr)`,
                    gap: isMobile ? 10 : 16,
                    maxWidth: 1100,
                    marginHorizontal: 'auto',
                  } as any : {}}
                >
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
                <View
                  className="gap-3"
                  style={Platform.OS === 'web' ? {
                    display: 'grid' as any,
                    gridTemplateColumns: `repeat(${gridColumns}, 1fr)`,
                    gap: isMobile ? 10 : 16,
                    maxWidth: 1100,
                    marginHorizontal: 'auto',
                  } as any : {}}
                >
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
