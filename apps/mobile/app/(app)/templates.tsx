// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
} from 'react-native'
import { useRouter } from 'expo-router'
import { observer } from 'mobx-react-lite'
import { cn } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import {
  useProjectCollection,
  useDomainActions,
  useDomainHttp,
} from '../../contexts/domain'
import { api, type AgentTemplateSummary, type AppTemplateSummary } from '../../lib/api'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { usePostHogSafe } from '../../contexts/posthog'

type AgentTemplate = AgentTemplateSummary

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

const TEMPLATE_COLORS: Record<string, string> = {
  'research-assistant': '#3b82f6',
  'github-ops': '#f97316',
  'support-desk': '#8b5cf6',
  'meeting-prep': '#10b981',
  'revenue-tracker': '#ec4899',
  'project-board': '#06b6d4',
  'incident-commander': '#ef4444',
  'personal-assistant': '#f59e0b',
  'sales-pipeline': '#eab308',
  'social-media-manager': '#a855f7',
  'release-manager': '#22d3ee',
  'hiring-pipeline': '#14b8a6',
  'newsletter-curator': '#f472b6',
  'competitor-intel': '#6366f1',
  'api-health-monitor': '#e11d48',
  'expense-manager': '#84cc16',
  'fitness-coach': '#f97316',
  'daily-journal': '#8b5cf6',
  'market-watch': '#0ea5e9',
  'code-review-assistant': '#10b981',
  'client-onboarding': '#d946ef',
  'travel-planner': '#06b6d4',
  'email-slack-alert': '#e11d48',
  'dev-activity': '#2563eb',
  'standup-generator': '#16a34a',
  'slack-monitor': '#7c3aed',
  'git-insights': '#0d9488',
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

const AGENT_FILTER_TABS = [
  { key: 'all', label: 'All Templates', icon: '⊞' },
  { key: 'sales', label: 'Sales', icon: '🏆' },
  { key: 'marketing', label: 'Marketing', icon: '📣' },
  { key: 'business', label: 'Business', icon: '💼' },
  { key: 'development', label: 'Development', icon: '🐙' },
  { key: 'research', label: 'Research', icon: '📚' },
  { key: 'operations', label: 'DevOps', icon: '🚨' },
  { key: 'personal', label: 'Personal', icon: '⚡' },
]

const APP_FILTER_TABS = [
  { key: 'all', label: 'All Apps', icon: '⊞' },
  { key: 'beginner', label: 'Beginner', icon: '🌱' },
  { key: 'intermediate', label: 'Intermediate', icon: '⚡' },
  { key: 'advanced', label: 'Advanced', icon: '🔥' },
]

function AgentTemplateCard({
  template,
  isLoading,
  onPress,
  isDark,
}: {
  template: AgentTemplate
  isLoading: boolean
  onPress: () => void
  isDark: boolean
}) {
  const color = TEMPLATE_COLORS[template.id] || '#6366f1'

  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      className={cn(
        'rounded-2xl overflow-hidden border border-border bg-card',
        isLoading && 'opacity-50',
      )}
      style={Platform.OS === 'web' ? {
        boxShadow: isDark
          ? '0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)'
          : '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        transition: 'box-shadow 0.2s ease, transform 0.15s ease',
        cursor: 'pointer',
      } as any : {}}
    >
      <View
        style={{
          height: 240,
          backgroundColor: isDark ? `${color}15` : `${color}06`,
          borderBottomWidth: 1,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6',
        }}
        className="items-center justify-center"
      >
        <Text style={{ fontSize: 56 }}>{template.icon}</Text>
        <Text
          className="text-muted-foreground"
          style={{
            fontSize: 11,
            fontWeight: '500',
            marginTop: 12,
            letterSpacing: 0.5,
          }}
        >
          Preview coming soon
        </Text>
      </View>

      <View className="px-5 py-4">
        <View className="flex-row items-start justify-between gap-2">
          <View className="flex-1">
            <Text className="text-base font-semibold text-card-foreground" style={{ lineHeight: 22 }}>
              {template.name}
            </Text>
            <Text
              className="text-[13px] mt-1.5 leading-[19px] text-muted-foreground"
              numberOfLines={2}
            >
              {template.description}
            </Text>
          </View>
          <View className="rounded-full px-2.5 py-1 mt-0.5 bg-muted">
            <Text className="text-[11px] font-medium text-muted-foreground">
              {template.tags[0] ? template.tags[0].charAt(0).toUpperCase() + template.tags[0].slice(1) : template.category}
            </Text>
          </View>
        </View>
      </View>

      {isLoading && (
        <View
          className="absolute inset-0 items-center justify-center rounded-2xl"
          style={{ backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)' }}
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
}: {
  template: AppTemplateSummary
  isLoading: boolean
  onPress: () => void
  isDark: boolean
}) {
  const color = APP_TEMPLATE_COLORS[template.name] || '#6366f1'
  const icon = APP_TEMPLATE_ICONS[template.name] || '🧩'
  const complexityLabel = template.complexity.charAt(0).toUpperCase() + template.complexity.slice(1)
  const displayName = template.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      className={cn(
        'rounded-2xl overflow-hidden border border-border bg-card',
        isLoading && 'opacity-50',
      )}
      style={Platform.OS === 'web' ? {
        boxShadow: isDark
          ? '0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)'
          : '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        transition: 'box-shadow 0.2s ease, transform 0.15s ease',
        cursor: 'pointer',
      } as any : {}}
    >
      <View
        style={{
          height: 240,
          backgroundColor: isDark ? `${color}15` : `${color}06`,
          borderBottomWidth: 1,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6',
        }}
        className="items-center justify-center"
      >
        <Text style={{ fontSize: 56 }}>{icon}</Text>
      </View>

      <View className="px-5 py-4">
        <View className="flex-row items-start justify-between gap-2">
          <View className="flex-1">
            <Text className="text-base font-semibold text-card-foreground" style={{ lineHeight: 22 }}>
              {displayName}
            </Text>
            <Text
              className="text-[13px] mt-1.5 leading-[19px] text-muted-foreground"
              numberOfLines={2}
            >
              {template.description}
            </Text>
          </View>
          <View className="rounded-full px-2.5 py-1 mt-0.5 bg-muted">
            <Text className="text-[11px] font-medium text-muted-foreground">
              {complexityLabel}
            </Text>
          </View>
        </View>
        <View className="flex-row flex-wrap gap-1.5 mt-3">
          {Object.entries(template.techStack).filter(([, v]) => v).slice(0, 4).map(([key, value]) => (
            <View key={key} className="rounded-md px-2 py-0.5 bg-muted/60">
              <Text className="text-[10px] font-medium text-muted-foreground">{value}</Text>
            </View>
          ))}
        </View>
      </View>

      {isLoading && (
        <View
          className="absolute inset-0 items-center justify-center rounded-2xl"
          style={{ backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.85)' }}
        >
          <ActivityIndicator size="small" color={color} />
        </View>
      )}
    </Pressable>
  )
}

export default observer(function TemplatesPage() {
  const router = useRouter()
  const { user } = useAuth()
  const http = useDomainHttp()
  const actions = useDomainActions()
  const projects = useProjectCollection()
  const posthog = usePostHogSafe()
  const isDark = useDarkMode()
  const [agentTemplates, setAgentTemplates] = useState<AgentTemplate[]>([])
  const [appTemplates, setAppTemplates] = useState<AppTemplateSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  const [activeFilter, setActiveFilter] = useState('all')
  const [templateMode, setTemplateMode] = useState<'agents' | 'apps'>('agents')

  const currentWorkspace = useActiveWorkspace()

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const [agents, apps] = await Promise.all([
          api.getAgentTemplates(http),
          api.getAppTemplates(http),
        ])
        setAgentTemplates(agents)
        setAppTemplates(apps)
      } catch (err) {
        console.error('[TemplatesPage] Failed to fetch templates:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchTemplates()
  }, [http])

  useEffect(() => {
    setActiveFilter('all')
  }, [templateMode])

  const handleAgentTemplatePress = useCallback(
    async (template: AgentTemplate) => {
      if (!user?.id || !currentWorkspace?.id) {
        Alert.alert('Error', 'No user session or workspace available')
        return
      }

      setLoadingTemplate(template.id)

      try {
        const project = await actions.createProject(
          template.name,
          currentWorkspace.id,
          template.description,
          user.id,
          undefined,
          template.id
        )

        if (project?.id) {
          projects.loadAll()
          trackEvent(posthog, EVENTS.PROJECT_CREATED, {
            source: 'template',
            template_id: template.id,
            template_name: template.name,
          })
          const onboardingMessage = `The "${template.name}" template has been installed. Can you describe what's been set up and walk me through how to customize it or connect my own tools?`
          router.push({
            pathname: '/(app)/projects/[id]',
            params: { id: project.id, initialMessage: onboardingMessage },
          })
        }
      } catch (error) {
        console.error('[TemplatesPage] Failed to create project:', error)
        Alert.alert('Error', 'Failed to create project from template')
      } finally {
        setLoadingTemplate(null)
      }
    },
    [user?.id, currentWorkspace?.id, actions, projects, router, posthog]
  )

  const handleAppTemplatePress = useCallback(
    async (template: AppTemplateSummary) => {
      if (!user?.id || !currentWorkspace?.id) {
        Alert.alert('Error', 'No user session or workspace available')
        return
      }

      setLoadingTemplate(template.name)

      try {
        const displayName = template.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
        const project = await actions.createProject(
          displayName,
          currentWorkspace.id,
          template.description,
          user.id,
          'APP',
        )

        if (project?.id) {
          projects.loadAll()
          trackEvent(posthog, EVENTS.PROJECT_CREATED, {
            source: 'app_template',
            template_name: template.name,
          })
          router.push({
            pathname: '/(app)/projects/[id]',
            params: {
              id: project.id,
              appTemplateName: template.name,
            },
          })
        }
      } catch (error) {
        console.error('[TemplatesPage] Failed to create project from app template:', error)
        Alert.alert('Error', 'Failed to create project from template')
      } finally {
        setLoadingTemplate(null)
      }
    },
    [user?.id, currentWorkspace?.id, actions, projects, router, posthog]
  )

  // Deduplicate agent templates (API may return duplicates, causing React key collisions)
  const uniqueAgentTemplates = useMemo(() => {
    const seen = new Set<string>()
    return agentTemplates.filter(t => {
      if (seen.has(t.id)) return false
      seen.add(t.id)
      return true
    })
  }, [agentTemplates])

  const filteredAgentTemplates =
    activeFilter === 'all'
      ? uniqueAgentTemplates
      : uniqueAgentTemplates.filter((t) => t.category === activeFilter)

  const filteredAppTemplates =
    activeFilter === 'all'
      ? appTemplates
      : appTemplates.filter((t) => t.complexity === activeFilter)

  const filterTabs = templateMode === 'agents' ? AGENT_FILTER_TABS : APP_FILTER_TABS
  const currentTemplates = templateMode === 'agents' ? filteredAgentTemplates : filteredAppTemplates

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="large" className="text-muted-foreground" />
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 60 }}
      >
        {/* Header */}
        <View className="items-center pt-10 pb-6 px-6">
          <Text
            className="text-center font-bold text-foreground"
            style={{ fontSize: 32, lineHeight: 40, letterSpacing: -0.3 }}
          >
            {templateMode === 'agents' ? 'Agent Templates' : 'App Templates'}{'\n'}Built With AI
          </Text>
          <Text
            className="text-center mt-3 text-muted-foreground"
            style={{ fontSize: 15, lineHeight: 22 }}
          >
            {templateMode === 'agents'
              ? 'Production-ready agents from the Shogo team'
              : 'Full-stack app starters with database, auth, and UI'}
          </Text>
        </View>

        {/* Mode toggle */}
        <View className="px-6 mb-4 items-center">
          <View className="flex-row items-center gap-1 rounded-lg bg-muted p-1">
            {(['agents', 'apps'] as const).map((mode) => (
              <Pressable
                key={mode}
                onPress={() => setTemplateMode(mode)}
                className={cn(
                  'px-4 py-2 rounded-md',
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
        </View>

        {/* Filter tabs */}
        <View className="px-6 mb-8">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: 0,
              gap: 4,
              justifyContent: 'center',
              flexGrow: 1,
            }}
          >
            {filterTabs.map((tab) => {
              const isActive = activeFilter === tab.key
              return (
                <Pressable
                  key={tab.key}
                  onPress={() => setActiveFilter(tab.key)}
                  className="items-center px-4 py-2.5 rounded-lg"
                  style={{
                    borderBottomWidth: isActive ? 2 : 0,
                    borderBottomColor: isActive
                      ? (isDark ? 'rgba(255,255,255,0.87)' : '#111827')
                      : 'transparent',
                    marginBottom: isActive ? -2 : 0,
                  }}
                >
                  <Text style={{ fontSize: 18, marginBottom: 4 }}>{tab.icon}</Text>
                  <Text
                    className={cn(
                      'text-[12px]',
                      isActive ? 'text-foreground font-semibold' : 'text-muted-foreground',
                    )}
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
          <View className="border-b border-border" style={{ marginTop: 2 }} />
        </View>

        {/* Template grid */}
        <View className="px-6">
          {templateMode === 'agents' && filteredAgentTemplates.length > 0 && (
            <View
              style={Platform.OS === 'web' ? {
                display: 'grid' as any,
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 20,
                maxWidth: 1100,
                marginHorizontal: 'auto',
              } as any : {
                gap: 16,
              }}
            >
              {filteredAgentTemplates.map((template) => (
                <AgentTemplateCard
                  key={template.id}
                  template={template}
                  isLoading={loadingTemplate === template.id}
                  onPress={() => handleAgentTemplatePress(template)}
                  isDark={isDark}
                />
              ))}
            </View>
          )}
          {templateMode === 'apps' && filteredAppTemplates.length > 0 && (
            <View
              style={Platform.OS === 'web' ? {
                display: 'grid' as any,
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 20,
                maxWidth: 1100,
                marginHorizontal: 'auto',
              } as any : {
                gap: 16,
              }}
            >
              {filteredAppTemplates.map((template) => (
                <AppTemplateCard
                  key={template.name}
                  template={template}
                  isLoading={loadingTemplate === template.name}
                  onPress={() => handleAppTemplatePress(template)}
                  isDark={isDark}
                />
              ))}
            </View>
          )}
          {currentTemplates.length === 0 && (
            <View className="items-center py-16">
              <Text className="text-muted-foreground text-sm">
                No templates in this category yet
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  )
})
