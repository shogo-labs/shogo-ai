import { useState, useEffect, useCallback } from 'react'
import {
  View,
  Text,
  Pressable,
  FlatList,
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
  useWorkspaceCollection,
  useProjectCollection,
  useDomainActions,
} from '../../contexts/domain'
import { API_URL } from '../../lib/api'

interface AgentTemplate {
  id: string
  name: string
  description: string
  category: string
  icon: string
  tags: string[]
  settings: {
    heartbeatInterval: number
    heartbeatEnabled: boolean
    modelProvider: string
    modelName: string
  }
  skills: string[]
}

const CATEGORY_ORDER = ['research', 'development', 'business', 'operations', 'personal']

function TemplateCard({
  template,
  isLoading,
  onPress,
}: {
  template: AgentTemplate
  isLoading: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      className={cn(
        'flex-1 mx-1.5 mb-3 rounded-xl p-4 border border-border/50 bg-card/60',
        isLoading && 'opacity-50'
      )}
    >
      <View className="flex-row items-start gap-3">
        <Text className="text-2xl mt-0.5">{template.icon}</Text>
        <View className="flex-1">
          <Text className="text-foreground font-semibold text-[15px] leading-tight">
            {template.name}
          </Text>
          <Text className="text-muted-foreground text-sm mt-1" numberOfLines={2}>
            {template.description}
          </Text>
        </View>
      </View>

      <View className="flex-row items-center gap-2 mt-3 flex-wrap">
        {template.skills.slice(0, 2).map((skill) => (
          <View
            key={skill}
            className="bg-blue-500/10 border border-blue-500/20 rounded-full px-2 py-0.5"
          >
            <Text className="text-blue-400 text-[11px] font-medium">{skill}</Text>
          </View>
        ))}
        {template.tags.slice(0, 2).map((tag) => (
          <View
            key={tag}
            className="bg-muted/50 border border-border/50 rounded-full px-2 py-0.5"
          >
            <Text className="text-muted-foreground text-[11px]">{tag}</Text>
          </View>
        ))}
      </View>

      {isLoading && (
        <View className="absolute inset-0 bg-background/60 items-center justify-center rounded-xl">
          <ActivityIndicator size="small" />
        </View>
      )}
    </Pressable>
  )
}

export default observer(function TemplatesPage() {
  const router = useRouter()
  const { user } = useAuth()
  const actions = useDomainActions()
  const workspaces = useWorkspaceCollection()
  const projects = useProjectCollection()
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [categories, setCategories] = useState<Record<string, { label: string; icon: string; description: string }>>({})
  const [loading, setLoading] = useState(true)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)

  const currentWorkspace = workspaces.all.length > 0 ? workspaces.all[0] : null

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const res = await fetch(`${API_URL}/api/agent-templates`)
        if (!res.ok) throw new Error('Failed to fetch templates')
        const data = await res.json()
        setTemplates(data.templates || [])
        setCategories(data.categories || {})
      } catch (err) {
        console.error('[TemplatesPage] Failed to fetch templates:', err)
      } finally {
        setLoading(false)
      }
    }
    fetchTemplates()
  }, [])

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

  const groupedTemplates = CATEGORY_ORDER
    .filter((cat) => templates.some((t) => t.category === cat))
    .map((cat) => ({
      category: cat,
      label: categories[cat]?.label || cat,
      templates: templates.filter((t) => t.category === cat),
    }))

  if (loading) {
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" />
      </View>
    )
  }

  return (
    <View className="flex-1 bg-background">
      <View className="px-6 pt-6 pb-2">
        <Text className="text-foreground text-2xl font-semibold">Agent Templates</Text>
        <Text className="text-muted-foreground mt-1">
          Pre-built agents with skills, settings, and canvas dashboards
        </Text>
      </View>

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 24, paddingTop: 12 }}
      >
        {groupedTemplates.map((group) => (
          <View key={group.category} className="mb-6">
            <Text className="text-foreground font-semibold text-base mb-3">
              {group.label}
            </Text>
            {Platform.OS === 'web' ? (
              <View
                style={{
                  display: 'grid' as any,
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: 12,
                  maxWidth: 1200,
                } as any}
              >
                {group.templates.map((template) => (
                  <TemplateCard
                    key={template.id}
                    template={template}
                    isLoading={loadingTemplate === template.id}
                    onPress={() => handleTemplatePress(template)}
                  />
                ))}
              </View>
            ) : (
              <FlatList
                data={group.templates}
                keyExtractor={(item) => item.id}
                numColumns={2}
                scrollEnabled={false}
                renderItem={({ item }) => (
                  <TemplateCard
                    template={item}
                    isLoading={loadingTemplate === item.id}
                    onPress={() => handleTemplatePress(item)}
                  />
                )}
              />
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  )
})
