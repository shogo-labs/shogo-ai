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
import { CompactChatInput } from '../../components/chat/CompactChatInput'
import type { FileAttachment } from '../../components/chat/ChatInput'
import { setPendingFiles } from '../../lib/pending-image-store'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { api, type AppTemplateSummary } from '../../lib/api'
import { EVENTS, trackEvent } from '../../lib/analytics'

interface AgentTemplate {
  id: string
  name: string
  description: string
  category: string
  icon: string
  tags: string[]
  settings: any
  skills: string[]
}

const APP_TEMPLATE_COLORS: Record<string, string> = {
  'todo-app': '#3b82f6',
  'crm': '#f97316',
  'kanban': '#8b5cf6',
  'expense-tracker': '#10b981',
  'booking-app': '#ec4899',
  'inventory': '#06b6d4',
  'ai-chat': '#ef4444',
  'form-builder': '#f59e0b',
  'feedback-form': '#84cc16',
}

const APP_TEMPLATE_ICONS: Record<string, string> = {
  'todo-app': '✅',
  'crm': '🤝',
  'kanban': '📋',
  'expense-tracker': '💰',
  'booking-app': '📅',
  'inventory': '📦',
  'ai-chat': '🤖',
  'form-builder': '📝',
  'feedback-form': '💬',
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


const TEMPLATE_COLORS: Record<string, string> = {
  'research-assistant': '#3b82f6',
  'github-ops': '#f97316',
  'support-desk': '#8b5cf6',
  'meeting-prep': '#10b981',
  'revenue-tracker': '#ec4899',
  'project-board': '#06b6d4',
  'incident-commander': '#ef4444',
  'personal-assistant': '#f59e0b',
}

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

function TemplateCard({
  template,
  isLoading,
  onPress,
  isDark,
  compact,
}: {
  template: AgentTemplate
  isLoading: boolean
  onPress: () => void
  isDark: boolean
  compact?: boolean
}) {
  const color = TEMPLATE_COLORS[template.id] || '#6366f1'

  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      className={cn(
        'rounded-2xl overflow-hidden border border-border bg-card',
        isLoading && 'opacity-50'
      )}
      style={Platform.OS === 'web' ? {
        boxShadow: isDark
          ? '0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)'
          : '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        transition: 'box-shadow 0.2s, transform 0.2s',
      } as any : {}}
    >
      <View
        style={{
          height: compact ? 100 : 180,
          backgroundColor: isDark ? `${color}15` : `${color}08`,
          borderBottomWidth: 1,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6',
        }}
        className="items-center justify-center"
      >
        <Text style={{ fontSize: compact ? 36 : 48 }}>{template.icon}</Text>
      </View>

      <View className={compact ? 'px-3 py-2.5' : 'px-4 py-3.5'}>
        <View className="flex-row items-center justify-between gap-1">
          <Text
            className={cn(
              'font-semibold text-card-foreground flex-1',
              compact ? 'text-[13px]' : 'text-[15px]',
            )}
            numberOfLines={1}
          >
            {template.name}
          </Text>
          {!compact && (
            <View className="rounded-full px-2.5 py-0.5 bg-muted flex-shrink-0">
              <Text className="text-[11px] font-medium text-muted-foreground">
                {template.tags[0]
                  ? template.tags[0].charAt(0).toUpperCase() + template.tags[0].slice(1)
                  : template.category}
              </Text>
            </View>
          )}
        </View>
        <Text
          className={cn(
            'mt-1 leading-[18px] text-muted-foreground',
            compact ? 'text-[11px]' : 'text-[13px]',
          )}
          numberOfLines={2}
        >
          {template.description}
        </Text>
      </View>

      {isLoading && (
        <View
          className="absolute inset-0 items-center justify-center rounded-2xl"
          style={{ backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)' }}
        >
          <ActivityIndicator size="small" color={color} />
        </View>
      )}
    </Pressable>
  )
}

function AppTemplateCard({
  template,
  isLoading,
  onPress,
  isDark,
  compact,
}: {
  template: AppTemplateSummary
  isLoading: boolean
  onPress: () => void
  isDark: boolean
  compact?: boolean
}) {
  const color = APP_TEMPLATE_COLORS[template.name] || '#6366f1'
  const icon = APP_TEMPLATE_ICONS[template.name] || '🧩'
  const complexityLabel = template.complexity.charAt(0).toUpperCase() + template.complexity.slice(1)

  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      className={cn(
        'rounded-2xl overflow-hidden border border-border bg-card',
        isLoading && 'opacity-50'
      )}
      style={Platform.OS === 'web' ? {
        boxShadow: isDark
          ? '0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)'
          : '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        transition: 'box-shadow 0.2s, transform 0.2s',
      } as any : {}}
    >
      <View
        style={{
          height: compact ? 100 : 180,
          backgroundColor: isDark ? `${color}15` : `${color}08`,
          borderBottomWidth: 1,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6',
        }}
        className="items-center justify-center"
      >
        <Text style={{ fontSize: compact ? 36 : 48 }}>{icon}</Text>
      </View>

      <View className={compact ? 'px-3 py-2.5' : 'px-4 py-3.5'}>
        <View className="flex-row items-center justify-between gap-1">
          <Text
            className={cn(
              'font-semibold text-card-foreground flex-1',
              compact ? 'text-[13px]' : 'text-[15px]',
            )}
            numberOfLines={1}
          >
            {template.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
          </Text>
          {!compact && (
            <View className="rounded-full px-2.5 py-0.5 bg-muted flex-shrink-0">
              <Text className="text-[11px] font-medium text-muted-foreground">
                {complexityLabel}
              </Text>
            </View>
          )}
        </View>
        <Text
          className={cn(
            'mt-1 leading-[18px] text-muted-foreground',
            compact ? 'text-[11px]' : 'text-[13px]',
          )}
          numberOfLines={2}
        >
          {template.description}
        </Text>
      </View>

      {isLoading && (
        <View
          className="absolute inset-0 items-center justify-center rounded-2xl"
          style={{ backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.8)' }}
        >
          <ActivityIndicator size="small" color={color} />
        </View>
      )}
    </Pressable>
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
  const [isCreating, setIsCreating] = useState(false)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  const [homeTemplates, setHomeTemplates] = useState<AgentTemplate[]>([])
  const [homeAppTemplates, setHomeAppTemplates] = useState<AppTemplateSummary[]>([])
  const [activeTab, setActiveTab] = useState<'projects' | 'shared' | 'templates'>('templates')
  const [templateMode, setTemplateMode] = useState<'agents' | 'apps'>('agents')

  const [workspaceError, setWorkspaceError] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) return
    setWorkspaceError(false)
    projects.loadAll().catch(() => {})
    workspaces.loadAll().catch((err: any) => {
      console.error('[Home] Failed to load workspaces:', err)
      setWorkspaceError(true)
    })
    if (user?.id) {
      membersColl.loadAll({ userId: user.id }).catch(() => {})
    }

    async function fetchTemplates() {
      try {
        const [agentData, appData] = await Promise.all([
          api.getAgentTemplates(http),
          api.getAppTemplates(http),
        ])
        setHomeTemplates(agentData.slice(0, 6))
        setHomeAppTemplates(appData.slice(0, 6))
      } catch (err) {
        console.error('[Home] Failed to fetch templates:', err)
      }
    }
    fetchTemplates()
  }, [isAuthenticated, user?.id, http])

  const currentWorkspace = useActiveWorkspace()

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

  // Deep-link: auto-create project from pending app template
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return
    const pendingApp = localStorage.getItem('pending_app_template')
    if (!pendingApp || !currentWorkspace?.id || !user?.id) return
    if (homeAppTemplates.length === 0) return

    const template = homeAppTemplates.find(t => t.name === pendingApp)
    if (!template) {
      api.getAppTemplates(http).then((all) => {
        const found = all.find((t: AppTemplateSummary) => t.name === pendingApp)
        if (found) {
          localStorage.removeItem('pending_app_template')
          handleAppTemplatePress(found)
        } else {
          localStorage.removeItem('pending_app_template')
        }
      }).catch(() => {
        localStorage.removeItem('pending_app_template')
      })
      return
    }

    localStorage.removeItem('pending_app_template')
    handleAppTemplatePress(template)
  }, [homeAppTemplates, currentWorkspace?.id, user?.id])

  const myProjects = useMemo(() => {
    try {
      return [...(projects?.all ?? [])]
        .sort((a: any, b: any) => {
          const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
          const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
          return bTime - aTime
        })
    } catch {
      return []
    }
  }, [projects?.all])

  const sharedProjects = useMemo(() => {
    if (!user?.id) return []
    try {
      const userMembers = membersColl.all.filter((m: any) => m.userId === user.id)
      const sharedWsIds = new Set(
        workspaces.all
          .filter((ws: any) => {
            const membership = userMembers.find((m: any) => m.workspaceId === ws.id)
            return membership && membership.role !== 'owner'
          })
          .map((ws: any) => ws.id)
      )
      return [...(projects?.all ?? [])]
        .filter((p: any) => sharedWsIds.has(p.workspaceId))
        .sort((a: any, b: any) => {
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
          inferredName: `Chat - ${projectName}`,
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
        },
      } as any)
    } finally {
      setIsCreating(false)
    }
  }, [actions, user?.id, currentWorkspace?.id, projects, router, posthog])

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
        inferredName: `Chat - ${template.name}`,
        contextType: 'project',
        contextId: newProject.id,
      })
      trackEvent(posthog, EVENTS.PROJECT_CREATED, {
        source: 'template',
        template_id: template.id,
        template_name: template.name,
      })

      const onboardingMessage = `The "${template.name}" template has been installed. Can you describe what's been set up and walk me through how to customize it or connect my own tools?`
      projects.loadAll()
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: newProject.id,
          chatSessionId: chatSession.id,
          initialMessage: onboardingMessage,
        },
      } as any)
    } catch (error) {
      console.error('[Home] Failed to create project from template:', error)
      Alert.alert('Error', 'Failed to create project from template')
    } finally {
      setLoadingTemplate(null)
    }
  }, [actions, user?.id, currentWorkspace?.id, projects, router, posthog])

  const handleAppTemplatePress = useCallback(async (template: AppTemplateSummary) => {
    if (!user?.id || !currentWorkspace?.id) {
      Alert.alert('Not ready', 'Still loading your workspace. Please try again in a moment.')
      return
    }
    setLoadingTemplate(template.name)
    try {
      const displayName = template.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      const newProject = await actions.createProject(
        displayName,
        currentWorkspace.id,
        template.description,
        user.id,
        'APP',
      )
      const chatSession = await actions.createChatSession({
        inferredName: `Chat - ${displayName}`,
        contextType: 'project',
        contextId: newProject.id,
      })
      trackEvent(posthog, EVENTS.PROJECT_CREATED, {
        source: 'app_template',
        template_name: template.name,
      })

      projects.loadAll()
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: newProject.id,
          chatSessionId: chatSession.id,
          appTemplateName: template.name,
        },
      } as any)
    } catch (error) {
      console.error('[Home] Failed to create project from app template:', error)
      Alert.alert('Error', 'Failed to create project from template')
    } finally {
      setLoadingTemplate(null)
    }
  }, [actions, user?.id, currentWorkspace?.id, projects, router, posthog])

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
              className="w-full rounded-2xl overflow-hidden bg-card border border-border"
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
                placeholder="Ask Shogo to create..."
                value={prompt}
                onChange={setPrompt}
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
              <>
                <View className="flex-row items-center gap-1 mb-4 rounded-lg bg-muted p-1" style={{ alignSelf: 'flex-start' }}>
                  {(['agents', 'apps'] as const).map((mode) => (
                    <Pressable
                      key={mode}
                      onPress={() => setTemplateMode(mode)}
                      className={cn(
                        'px-3 py-1.5 rounded-md',
                        templateMode === mode && 'bg-background',
                      )}
                      style={templateMode === mode && Platform.OS === 'web' ? {
                        boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
                      } as any : {}}
                    >
                      <Text
                        className={cn(
                          'text-[13px]',
                          templateMode === mode
                            ? 'text-foreground font-semibold'
                            : 'text-muted-foreground',
                        )}
                      >
                        {mode === 'agents' ? 'Agents' : 'Apps'}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                {templateMode === 'agents' ? (
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
                        <TemplateCard
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
                ) : (
                  homeAppTemplates.length > 0 ? (
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
                      {homeAppTemplates.map((template) => (
                        <AppTemplateCard
                          key={template.name}
                          template={template}
                          isLoading={loadingTemplate === template.name}
                          onPress={() => handleAppTemplatePress(template)}
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
              </>
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
                  {myProjects.map((project: any) => (
                    <ProjectCard
                      key={project.id}
                      name={project.name || 'Untitled'}
                      description={project.description}
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
                  {sharedProjects.map((project: any) => (
                    <ProjectCard
                      key={project.id}
                      name={project.name || 'Untitled'}
                      description={project.description}
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
