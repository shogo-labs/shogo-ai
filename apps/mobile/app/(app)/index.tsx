import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import { ArrowRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import {
  useProjectCollection,
  useWorkspaceCollection,
  useDomainActions,
} from '../../contexts/domain'
import { CompactChatInput } from '../../components/chat/CompactChatInput'
import { setPendingImageData } from '../../lib/pending-image-store'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { API_URL } from '../../lib/api'

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
      <View className="absolute inset-0 overflow-hidden" pointerEvents="none">
        <View
          className="absolute w-[500px] h-[500px] rounded-full"
          style={{ top: '-10%', left: '10%', backgroundColor: `rgba(96, 165, 250, ${0.25 * o})` }}
        />
        <View
          className="absolute w-[500px] h-[500px] rounded-full"
          style={{ top: '10%', right: '-10%', backgroundColor: `rgba(244, 114, 182, ${0.25 * o})` }}
        />
        <View
          className="absolute w-[400px] h-[400px] rounded-full"
          style={{ bottom: '-5%', left: '30%', backgroundColor: `rgba(251, 113, 133, ${0.2 * o})` }}
        />
      </View>
    )
  }

  return (
    <View className="absolute inset-0 overflow-hidden" pointerEvents="none">
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
          height: 180,
          backgroundColor: isDark ? `${color}15` : `${color}08`,
          borderBottomWidth: 1,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : '#f3f4f6',
        }}
        className="items-center justify-center"
      >
        <Text style={{ fontSize: 48 }}>{template.icon}</Text>
        <Text
          style={{ color, fontSize: 11, fontWeight: '600', marginTop: 8, opacity: 0.7 }}
        >
          Preview coming soon
        </Text>
      </View>

      <View className="px-4 py-3.5">
        <View className="flex-row items-center justify-between">
          <Text className="text-[15px] font-semibold text-card-foreground">
            {template.name}
          </Text>
          <View className="rounded-full px-2.5 py-0.5 bg-muted">
            <Text className="text-[11px] font-medium text-muted-foreground">
              {template.tags[0]
                ? template.tags[0].charAt(0).toUpperCase() + template.tags[0].slice(1)
                : template.category}
            </Text>
          </View>
        </View>
        <Text
          className="text-[13px] mt-1 leading-[18px] text-muted-foreground"
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
  const projects = useProjectCollection()
  const workspaces = useWorkspaceCollection()
  const actions = useDomainActions()
  const isDark = useDarkMode()

  const [prompt, setPrompt] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  const [homeTemplates, setHomeTemplates] = useState<AgentTemplate[]>([])
  const [activeTab, setActiveTab] = useState<'recent' | 'projects' | 'shared' | 'templates'>('recent')

  const [workspaceError, setWorkspaceError] = useState(false)

  useEffect(() => {
    if (!isAuthenticated) return
    setWorkspaceError(false)
    projects.loadAll().catch(() => {})
    workspaces.loadAll().catch((err: any) => {
      console.error('[Home] Failed to load workspaces:', err)
      setWorkspaceError(true)
    })

    async function fetchTemplates() {
      try {
        const res = await fetch(`${API_URL}/api/agent-templates`)
        if (!res.ok) return
        const data = await res.json()
        setHomeTemplates((data.templates || []).slice(0, 6))
      } catch (err) {
        console.error('[Home] Failed to fetch templates:', err)
      }
    }
    fetchTemplates()
  }, [isAuthenticated])

  const currentWorkspace = useActiveWorkspace()

  const firstName = useMemo(() => {
    const name = user?.name || 'there'
    return name.split(' ')[0] || 'there'
  }, [user?.name])

  const handlePromptSubmit = useCallback(async (text: string, imageData?: string[]) => {
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
          'AGENT',
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

      if (imageData && imageData.length > 0) {
        setPendingImageData(imageData)
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
  }, [actions, user?.id, currentWorkspace?.id, projects, router])

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
  }, [actions, user?.id, currentWorkspace?.id, projects, router])

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
    { key: 'recent' as const, label: 'Recently viewed' },
    { key: 'projects' as const, label: 'My projects' },
    { key: 'shared' as const, label: 'Shared with me' },
    { key: 'templates' as const, label: 'Templates' },
  ]

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
        {/* Hero section with gradient */}
        <View className="relative" style={{ minHeight: 420 }}>
          <LovableGradient isDark={isDark} />

          <View className="relative items-center justify-center px-6 pt-16 pb-12">
            <Text
              className="text-center font-bold mb-2 text-foreground"
              style={{ fontSize: 36, lineHeight: 44, letterSpacing: -0.5 }}
            >
              What's on your mind, {firstName}?
            </Text>
            <Text
              className="text-center mb-8 text-muted-foreground"
              style={{ fontSize: 16 }}
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
          }}
        >
          <View className="flex-row items-center justify-between px-6 mb-5">
            <View className="flex-row items-center gap-1">
              {TAB_ITEMS.map((tab) => (
                <Pressable
                  key={tab.key}
                  onPress={() => setActiveTab(tab.key)}
                  className={cn(
                    'px-3.5 py-2 rounded-lg',
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
                  >
                    {tab.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Pressable
              onPress={() => router.push('/(app)/templates' as any)}
              className="flex-row items-center gap-1 active:opacity-70"
            >
              <Text className="text-[13px] font-medium text-foreground">
                Browse all
              </Text>
              <ArrowRight size={14} className="text-foreground" />
            </Pressable>
          </View>

          <View className="px-6 pb-10">
            {homeTemplates.length > 0 ? (
              <View
                className="gap-4"
                style={Platform.OS === 'web' ? {
                  display: 'grid' as any,
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 16,
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
                  />
                ))}
              </View>
            ) : (
              <View className="items-center py-12">
                <ActivityIndicator size="small" className="text-muted-foreground" />
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  )
})

export default HomeScreen
