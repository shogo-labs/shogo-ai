// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo } from 'react'
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
import type { FileAttachment, InteractionMode, AgentMode } from '../../components/chat/ChatInput'
import { saveInteractionModePreference } from '../../lib/interaction-mode-preference'
import { loadAgentModePreference, saveAgentModePreference } from '../../lib/agent-mode-preference'
import { setPendingFiles } from '../../lib/pending-image-store'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useTypingPlaceholder, AGENT_PLACEHOLDER_PREFIX } from '../../hooks/useTypingPlaceholder'
import { useBillingData } from '@shogo/shared-app/hooks'
import { api, getOnboardingMessage, type AgentTemplateSummary } from '../../lib/api'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { AgentTemplateGalleryCard } from '../../components/templates/agent-template-card'
// APP_MODE_DISABLED: import { AppTemplateGalleryCard } from '../../components/templates/app-template-card'

type AgentTemplate = AgentTemplateSummary

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
  const [agentMode, setAgentMode] = useState<AgentMode>('basic')
  const [isCreating, setIsCreating] = useState(false)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  const [homeTemplates, setHomeTemplates] = useState<AgentTemplate[]>([])
  // APP_MODE_DISABLED: homeAppTemplates state removed
  const [activeTab, setActiveTab] = useState<'projects' | 'shared' | 'templates'>('templates')

  const [workspaceError, setWorkspaceError] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) return
    setWorkspaceError(false)
    projects.loadAll().catch((e: any) => console.error('[Home] Failed to load projects:', e))
    workspaces.loadAll().catch((err: any) => {
      console.error('[Home] Failed to load workspaces:', err)
      setWorkspaceError(true)
    })
    if (user?.id) {
      membersColl.loadAll({ userId: user.id }).catch((e: any) => console.error('[Home] Failed to load memberships:', e))
    }

    async function fetchTemplates() {
      try {
        const agentData = await api.getAgentTemplates(http)
        setHomeTemplates(agentData.slice(0, 6))
        // APP_MODE_DISABLED: app template fetch removed
      } catch (err) {
        console.error('[Home] Failed to fetch templates:', err)
      }
    }
    fetchTemplates()
  }, [isAuthenticated, user?.id, http])

  const currentWorkspace = useActiveWorkspace()
  const billingData = useBillingData(currentWorkspace?.id)
  const hasAdvancedModelAccess = billingData.hasAdvancedModelAccess

  useEffect(() => {
    loadAgentModePreference().then((stored) => {
      if (stored) {
        setAgentMode(stored)
      } else if (hasAdvancedModelAccess) {
        setAgentMode("advanced")
      }
    })
  }, [hasAdvancedModelAccess])

  // Deep-link: auto-create project from pending template (website referral)
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return
    const pendingId = localStorage.getItem('pending_template_id')
    if (!pendingId || !currentWorkspace?.id || !user?.id) return
    if (homeTemplates.length === 0) return

    const template = homeTemplates.find(t => t.id === pendingId)
    if (!template) {
      // Template not in the first 6; fetch full list to find it
      api.getAgentTemplates(http).then((all) => {
        const found = all.find((t: AgentTemplate) => t.id === pendingId)
        if (found) {
          localStorage.removeItem('pending_template_id')
          handleTemplatePress(found)
        } else {
          localStorage.removeItem('pending_template_id')
        }
      }).catch(() => {
        localStorage.removeItem('pending_template_id')
      })
      return
    }

    localStorage.removeItem('pending_template_id')
    handleTemplatePress(template)
  }, [homeTemplates, currentWorkspace?.id, user?.id])

  // APP_MODE_DISABLED: pending_app_template deep-link removed

  const myProjects = useMemo((): IProject[] => {
    try {
      return [...(projects?.all ?? [])]
        .sort((a, b) => {
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

  const handleHomeAgentModeChange = useCallback((mode: AgentMode) => {
    setAgentMode(mode)
    void saveAgentModePreference(mode)
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

  const handlePromptSubmit = useCallback(async (text: string, files?: FileAttachment[]) => {
    if (!text.trim() || !user?.id || !currentWorkspace?.id) return
    setIsCreating(true)
    try {
      const projectName = generateProjectNameFromPrompt(text)

      let newProject
      try {
        newProject = await actions.createProject(
          projectName,
          currentWorkspace.id,
          undefined,
          user.id,
        )
      } catch (err: any) {
        const detail = err?.message || err?.details?.error?.message || String(err)
        console.error('[Home] Failed to create project:', detail, err)
        Alert.alert('Error', `Failed to create project: ${detail}`)
        return
      }

      let chatSession
      try {
        chatSession = await actions.createChatSession({
          inferredName: 'Untitled',
          contextType: 'project',
          contextId: newProject.id,
        })
      } catch (err: any) {
        const detail = err?.message || err?.details?.error?.message || String(err)
        console.error('[Home] Failed to create chat session:', detail, err)
        Alert.alert('Error', `Failed to create chat session: ${detail}`)
        return
      }

      trackEvent(posthog, EVENTS.PROJECT_CREATED, { source: 'prompt' })

      if (files && files.length > 0) {
        setPendingFiles(files)
      }
      projects.loadAll()
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: newProject.id,
          chatSessionId: chatSession.id,
          initialMessage: text,
          initialInteractionMode: interactionMode,
        },
      } as any)

      // Fire-and-forget: replace heuristic name with AI-generated name
      const pid = newProject.id
      const sid = chatSession.id
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
  }, [actions, http, user?.id, currentWorkspace?.id, projects, router, posthog, interactionMode])

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

      const onboardingMessage = getOnboardingMessage(template.name)
      const hasIntegrations = template.integrations && template.integrations.length > 0
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
              <CompactChatInput
                onSubmit={handlePromptSubmit}
                isLoading={isCreating}
                placeholder={homeComposerPlaceholder}
                value={prompt}
                onChange={setPrompt}
                interactionMode={interactionMode}
                onInteractionModeChange={handleHomeInteractionModeChange}
                agentMode={agentMode}
                onAgentModeChange={handleHomeAgentModeChange}
                isPro={hasAdvancedModelAccess}
                onUpgradeClick={() => router.push('/billing')}
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
