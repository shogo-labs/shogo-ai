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
  Modal,
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
import { api, getOnboardingMessage, type AgentTemplateSummary, type EvalOutputRun, type EvalOutputEntry } from '../../lib/api'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { EVENTS, trackEvent } from '../../lib/analytics'
import { usePostHogSafe } from '../../contexts/posthog'
import { Download, X } from 'lucide-react-native'
import { AgentTemplateGalleryCard } from '../../components/templates/agent-template-card'
// APP_MODE_DISABLED: import { AppTemplateGalleryCard } from '../../components/templates/app-template-card'

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
  { key: 'all', label: 'All Templates' },
  { key: 'sales', label: 'Sales' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'business', label: 'Business' },
  { key: 'development', label: 'Development' },
  { key: 'research', label: 'Research' },
  { key: 'operations', label: 'DevOps' },
  { key: 'personal', label: 'Personal' },
]

// APP_MODE_DISABLED: APP_FILTER_TABS removed

export default observer(function TemplatesPage() {
  const router = useRouter()
  const { user } = useAuth()
  const http = useDomainHttp()
  const actions = useDomainActions()
  const projects = useProjectCollection()
  const posthog = usePostHogSafe()
  const isDark = useDarkMode()
  const [agentTemplates, setAgentTemplates] = useState<AgentTemplate[]>([])
  // APP_MODE_DISABLED: appTemplates state removed
  const [loading, setLoading] = useState(true)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  const [activeFilter, setActiveFilter] = useState('all')
  const [importModalVisible, setImportModalVisible] = useState(false)
  const [evalRuns, setEvalRuns] = useState<EvalOutputRun[]>([])
  const [loadingEvals, setLoadingEvals] = useState(false)
  const [importingPath, setImportingPath] = useState<string | null>(null)

  const currentWorkspace = useActiveWorkspace()

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const agents = await api.getAgentTemplates(http)
        setAgentTemplates(agents)
        // APP_MODE_DISABLED: app template fetch removed
      } catch (err) {
        console.error('[TemplatesPage] Failed to fetch templates:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchTemplates()
  }, [http])

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
          const onboardingMessage = getOnboardingMessage(template.name)
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

  // APP_MODE_DISABLED: handleAppTemplatePress removed

  const openImportModal = useCallback(async () => {
    setImportModalVisible(true)
    setLoadingEvals(true)
    try {
      const runs = await api.getEvalOutputs(http)
      setEvalRuns(runs)
    } catch (err) {
      console.error('[TemplatesPage] Failed to fetch eval outputs:', err)
    } finally {
      setLoadingEvals(false)
    }
  }, [http])

  const handleImportEval = useCallback(
    async (entry: EvalOutputEntry) => {
      if (!user?.id || !currentWorkspace?.id) {
        Alert.alert('Error', 'No user session or workspace available')
        return
      }
      setImportingPath(entry.path)
      try {
        const project = await api.importEvalAsProject(http, {
          evalOutputPath: entry.path,
          workspaceId: currentWorkspace.id,
          userId: user.id,
          name: entry.name,
        })
        if (project?.id) {
          projects.loadAll()
          trackEvent(posthog, EVENTS.PROJECT_CREATED, {
            source: 'eval-import',
            eval_id: entry.id,
            eval_name: entry.name,
          })
          setImportModalVisible(false)
          router.push({
            pathname: '/(app)/projects/[id]',
            params: { id: project.id },
          })
        }
      } catch (error) {
        console.error('[TemplatesPage] Failed to import eval:', error)
        Alert.alert('Error', 'Failed to import eval output as project')
      } finally {
        setImportingPath(null)
      }
    },
    [user?.id, currentWorkspace?.id, http, projects, router, posthog]
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

  const filterTabs = AGENT_FILTER_TABS
  const currentTemplates = filteredAgentTemplates

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
          <Pressable
            onPress={openImportModal}
            className="mt-4 flex-row items-center gap-2 px-4 py-2 rounded-lg border border-border bg-card"
          >
            <Download size={16} className="text-foreground" />
            <Text className="text-sm font-medium text-foreground">Import Template</Text>
          </Pressable>
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
                  className="px-4 py-2.5 rounded-lg"
                  style={{
                    borderBottomWidth: isActive ? 2 : 0,
                    borderBottomColor: isActive
                      ? (isDark ? 'rgba(255,255,255,0.87)' : '#111827')
                      : 'transparent',
                    marginBottom: isActive ? -2 : 0,
                  }}
                >
                  <Text
                    className={cn(
                      'text-[13px]',
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
          {filteredAgentTemplates.length > 0 && (
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
          {currentTemplates.length === 0 && (
            <View className="items-center py-16">
              <Text className="text-muted-foreground text-sm">
                No templates in this category yet
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* Import from Eval Output modal */}
      <Modal
        visible={importModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setImportModalVisible(false)}
      >
        <View className="flex-1 bg-background">
          <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-border">
            <Text className="text-lg font-bold text-foreground">Import from Eval Output</Text>
            <Pressable onPress={() => setImportModalVisible(false)} className="p-2">
              <X size={20} className="text-muted-foreground" />
            </Pressable>
          </View>
          <ScrollView className="flex-1 px-6 pt-4" contentContainerStyle={{ paddingBottom: 40 }}>
            {loadingEvals ? (
              <View className="items-center py-16">
                <ActivityIndicator size="large" className="text-muted-foreground" />
              </View>
            ) : evalRuns.length === 0 ? (
              <View className="items-center py-16">
                <Text className="text-muted-foreground text-sm text-center">
                  No eval outputs found.{'\n'}Run evals with --save-workspaces to generate outputs.
                </Text>
              </View>
            ) : (
              evalRuns.map((run) => (
                <View key={run.dirName} className="mb-6">
                  <Text className="text-sm font-semibold text-foreground mb-1">{run.track}</Text>
                  <Text className="text-xs text-muted-foreground mb-3">{run.timestamp}</Text>
                  {run.entries.map((entry) => (
                    <View
                      key={entry.path}
                      className="flex-row items-center justify-between p-3 mb-2 rounded-lg border border-border bg-card"
                    >
                      <View className="flex-1 mr-3">
                        <View className="flex-row items-center gap-2 mb-1">
                          <Text style={{ fontSize: 16 }}>{entry.icon}</Text>
                          <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
                            {entry.name}
                          </Text>
                        </View>
                        <Text className="text-xs text-muted-foreground" numberOfLines={2}>
                          {entry.description}
                        </Text>
                        <Text className="text-xs text-muted-foreground mt-1">
                          Score: {entry.score.earned}/{entry.score.max} ({Math.round(entry.score.percentage)}%)
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => handleImportEval(entry)}
                        disabled={importingPath !== null}
                        className={cn(
                          'px-3 py-1.5 rounded-md',
                          importingPath === entry.path ? 'bg-muted' : 'bg-primary',
                        )}
                      >
                        {importingPath === entry.path ? (
                          <ActivityIndicator size="small" className="text-primary-foreground" />
                        ) : (
                          <Text className="text-xs font-medium text-primary-foreground">Import</Text>
                        )}
                      </Pressable>
                    </View>
                  ))}
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  )
})
