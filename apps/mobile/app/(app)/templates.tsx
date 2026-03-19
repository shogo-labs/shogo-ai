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
import { AgentTemplateGalleryCard } from '../../components/templates/agent-template-card'
import { AppTemplateGalleryCard } from '../../components/templates/app-template-card'

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
          const hasIntegrations = template.integrations && template.integrations.length > 0
          router.push({
            pathname: '/(app)/projects/[id]',
            params: {
              id: project.id,
              initialMessage: onboardingMessage,
              ...(hasIntegrations ? { showIntegrations: '1' } : {}),
            },
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
                <AgentTemplateGalleryCard
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
                <AppTemplateGalleryCard
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
