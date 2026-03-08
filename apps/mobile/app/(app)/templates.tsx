// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback } from 'react'
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
  useDomainHttp,
} from '../../contexts/domain'
import { api, type AgentTemplateSummary } from '../../lib/api'
import { api, type AgentTemplateSummary } from '../../lib/api'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'

type AgentTemplate = AgentTemplateSummary
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

const FILTER_TABS = [
  { key: 'all', label: 'All Templates', icon: '⊞' },
  { key: 'sales', label: 'Sales', icon: '🏆' },
  { key: 'marketing', label: 'Marketing', icon: '📣' },
  { key: 'business', label: 'Business', icon: '💼' },
  { key: 'development', label: 'Development', icon: '🐙' },
  { key: 'research', label: 'Research', icon: '📚' },
  { key: 'operations', label: 'DevOps', icon: '🚨' },
  { key: 'personal', label: 'Personal', icon: '⚡' },
]

function TemplateCard({
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

export default observer(function TemplatesPage() {
  const router = useRouter()
  const { user } = useAuth()
  const http = useDomainHttp()
  const http = useDomainHttp()
  const actions = useDomainActions()
  const projects = useProjectCollection()
  const isDark = useDarkMode()
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  const [activeFilter, setActiveFilter] = useState('all')

  const currentWorkspace = useActiveWorkspace()

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const data = await api.getAgentTemplates(http)
        setTemplates(data)
        const data = await api.getAgentTemplates(http)
        setTemplates(data)
      } catch (err) {
        console.error('[TemplatesPage] Failed to fetch templates:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchTemplates()
  }, [http])
  }, [http])

  const handleTemplatePress = useCallback(
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
          'AGENT',
          template.id
        )

        if (project?.id) {
          projects.loadAll()
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
    [user?.id, currentWorkspace?.id, actions, projects, router]
  )

  const filteredTemplates =
    activeFilter === 'all'
      ? templates
      : templates.filter((t) => t.category === activeFilter)

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
            Agent Templates{'\n'}Built With AI
          </Text>
          <Text
            className="text-center mt-3 text-muted-foreground"
            style={{ fontSize: 15, lineHeight: 22 }}
          >
            Production-ready agents from the Shogo team
          </Text>
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
            {FILTER_TABS.map((tab) => {
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
          {filteredTemplates.length > 0 ? (
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
              {filteredTemplates.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  isLoading={loadingTemplate === template.id}
                  onPress={() => handleTemplatePress(template)}
                  isDark={isDark}
                />
              ))}
            </View>
          ) : (
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
