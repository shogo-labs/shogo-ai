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
import { Sparkles, ChevronRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Button } from '@shogo/shared-ui/primitives'
import { useAuth } from '../../contexts/auth'
import {
  useProjectCollection,
  useWorkspaceCollection,
  useDomainActions,
} from '../../contexts/domain'
import { CompactChatInput } from '../../components/chat/CompactChatInput'

const SUGGESTION_CHIPS = [
  'Build a customer support agent',
  'Create a research assistant',
  'Make a scheduling agent',
  'Design a data analysis agent',
]

interface CanvasTemplate {
  id: string
  name: string
  description: string
  user_request: string
  icon: string
}

const HOME_TEMPLATES: CanvasTemplate[] = [
  { id: 'analytics-dashboard', name: 'Analytics Dashboard', description: 'Revenue charts & top products', user_request: 'Create a sales analytics dashboard with revenue chart and top products', icon: '\u{1F4CA}' },
  { id: 'task-tracker-crud', name: 'Task Tracker', description: 'Add, complete & delete tasks', user_request: 'Build a task tracker where I can add, complete, and delete tasks', icon: '\u{2705}' },
  { id: 'crm-pipeline', name: 'CRM Pipeline', description: 'Leads across pipeline stages', user_request: 'Build a CRM pipeline canvas showing leads in 3 stages', icon: '\u{1F91D}' },
  { id: 'expense-dashboard', name: 'Expense Dashboard', description: 'Spend, budgets & recent expenses', user_request: 'Create an expense tracker dashboard with total spend, budget remaining, and a table of recent expenses', icon: '\u{1F4B0}' },
  { id: 'support-tickets-crud', name: 'Support Tickets', description: 'Priority levels & status tracking', user_request: 'Build a support ticket management app with CRUD API, priority levels, and status tracking', icon: '\u{1F3AB}' },
  { id: 'email-dashboard', name: 'Email Dashboard', description: 'Metrics, tabs & email tables', user_request: 'Build an email dashboard with metrics, tabs, and email tables', icon: '\u{1F4E7}' },
]

const GRADIENT_KEYFRAMES = `
@keyframes gradient-float {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(30px, -30px) scale(1.05); }
  66% { transform: translate(-20px, 20px) scale(0.95); }
}
@keyframes gradient-float-reverse {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(-25px, 25px) scale(1.03); }
  66% { transform: translate(15px, -15px) scale(0.97); }
}
@keyframes gradient-pulse {
  0%, 100% { opacity: 0.3; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(1.1); }
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

function GradientBackground() {
  if (Platform.OS !== 'web') {
    return (
      <View className="absolute inset-0 overflow-hidden" pointerEvents="none">
        <View
          className="absolute w-[400px] h-[400px] rounded-full"
          style={{ top: '10%', left: '10%', backgroundColor: 'rgba(59, 130, 246, 0.15)' }}
        />
        <View
          className="absolute w-[300px] h-[300px] rounded-full"
          style={{ bottom: '5%', right: '5%', backgroundColor: 'rgba(236, 72, 153, 0.1)' }}
        />
      </View>
    )
  }

  return (
    <View className="absolute inset-0 overflow-hidden" pointerEvents="none">
      <style dangerouslySetInnerHTML={{ __html: GRADIENT_KEYFRAMES }} />
      <div
        style={{
          position: 'absolute',
          width: 800,
          height: 800,
          borderRadius: '50%',
          filter: 'blur(120px)',
          background: 'radial-gradient(circle, rgba(59,130,246,0.6) 0%, rgba(139,92,246,0.5) 40%, rgba(236,72,153,0.4) 100%)',
          top: '10%',
          left: '20%',
          animation: 'gradient-float 15s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 600,
          height: 600,
          borderRadius: '50%',
          filter: 'blur(100px)',
          background: 'radial-gradient(circle, rgba(249,115,22,0.5) 0%, rgba(236,72,153,0.5) 50%, rgba(139,92,246,0.3) 100%)',
          bottom: '5%',
          right: '10%',
          animation: 'gradient-float-reverse 18s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 500,
          height: 500,
          borderRadius: '50%',
          filter: 'blur(100px)',
          background: 'radial-gradient(circle, rgba(34,211,238,0.3) 0%, rgba(59,130,246,0.3) 100%)',
          top: '50%',
          right: '30%',
          animation: 'gradient-pulse 12s ease-in-out infinite',
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 400,
          height: 400,
          borderRadius: '50%',
          filter: 'blur(80px)',
          background: 'radial-gradient(circle, rgba(236,72,153,0.5) 0%, rgba(168,85,247,0.3) 100%)',
          top: '30%',
          left: '50%',
          transform: 'translateX(-50%)',
          animation: 'gradient-float 20s ease-in-out infinite reverse',
        }}
      />
    </View>
  )
}

function TemplateCard({
  template,
  isLoading,
  onPress,
}: {
  template: CanvasTemplate
  isLoading: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={isLoading}
      className={cn(
        'rounded-xl p-4 border border-border/50 bg-card/60',
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
      {isLoading && (
        <View className="absolute inset-0 bg-background/60 items-center justify-center rounded-xl">
          <ActivityIndicator size="small" />
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

  const [prompt, setPrompt] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)

  useEffect(() => {
    if (!isAuthenticated) return
    projects.loadAll()
    workspaces.loadAll()
  }, [isAuthenticated])

  let currentWorkspace: any
  try { currentWorkspace = workspaces.all[0] } catch { currentWorkspace = undefined }

  const firstName = useMemo(() => {
    const name = user?.name || 'there'
    return name.split(' ')[0] || 'there'
  }, [user?.name])

  const handlePromptSubmit = useCallback(async (text: string) => {
    if (!text.trim() || !user?.id || !currentWorkspace?.id) return
    setIsCreating(true)
    try {
      const projectName = generateProjectNameFromPrompt(text)

      const newProject = await actions.createProject(
        projectName,
        currentWorkspace.id,
        undefined,
        user.id,
        'AGENT',
      )

      const chatSession = await actions.createChatSession({
        inferredName: `Chat - ${projectName}`,
        contextType: 'project',
        contextId: newProject.id,
      })

      projects.loadAll()
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: newProject.id,
          chatSessionId: chatSession.id,
          initialMessage: text,
        },
      } as any)
    } catch (error) {
      console.error('[Home] Failed to create project:', error)
      Alert.alert('Error', 'Failed to create project')
    } finally {
      setIsCreating(false)
    }
  }, [actions, user?.id, currentWorkspace?.id, projects, router])

  const handleTemplatePress = useCallback(async (template: CanvasTemplate) => {
    if (!user?.id || !currentWorkspace?.id) {
      Alert.alert('Error', 'No workspace available')
      return
    }
    setLoadingTemplate(template.id)
    try {
      const projectName = template.name

      const newProject = await actions.createProject(
        projectName,
        currentWorkspace.id,
        `Created from ${projectName} canvas template`,
        user.id,
        'AGENT',
      )

      const chatSession = await actions.createChatSession({
        inferredName: `Chat - ${projectName}`,
        contextType: 'project',
        contextId: newProject.id,
      })

      projects.loadAll()
      router.push({
        pathname: '/(app)/projects/[id]',
        params: {
          id: newProject.id,
          chatSessionId: chatSession.id,
          initialMessage: template.user_request,
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
          <Text className="text-foreground text-lg font-semibold mb-2">Welcome to Shogo</Text>
          <Text className="text-muted-foreground text-center mb-6">
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
      <ScrollView className="flex-1" contentContainerStyle={{ flexGrow: 1 }}>
        {/* Gradient mesh background */}
        <GradientBackground />

        {/* Main content */}
        <View className="relative items-center justify-center p-8" style={{ minHeight: '60%' }}>
          {/* Greeting */}
          <Text
            className="text-3xl sm:text-4xl md:text-5xl font-bold text-center mb-8 text-foreground"
          >
            What's on your mind, {firstName}?
          </Text>

          {/* Chat input */}
          <View className="w-full max-w-2xl">
            <CompactChatInput
              onSubmit={handlePromptSubmit}
              isLoading={isCreating}
              placeholder="Describe the agent you want to build..."
              value={prompt}
              onChange={setPrompt}
            />
          </View>

          {/* Suggestion chips */}
          <View className="mt-6 flex-row flex-wrap justify-center gap-2">
            {SUGGESTION_CHIPS.map((suggestion) => (
              <Pressable
                key={suggestion}
                onPress={() => setPrompt(suggestion)}
                className="flex-row items-center gap-1.5 h-8 px-3 rounded-md border border-border bg-card/50 active:bg-card"
              >
                <Sparkles size={12} className="text-purple-400" />
                <Text className="text-xs text-muted-foreground">{suggestion}</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Canvas Templates section */}
        <View className="border-t border-border py-6 bg-card/30">
          <View className="flex-row items-center justify-between mb-4 px-6">
            <Text className="text-sm font-medium text-foreground">Canvas Templates</Text>
            <Pressable
              onPress={() => router.push('/(app)/templates' as any)}
              className="flex-row items-center gap-1 active:opacity-70"
            >
              <Text className="text-sm text-muted-foreground">Browse all</Text>
              <ChevronRight size={16} className="text-muted-foreground" />
            </Pressable>
          </View>

          <View className="px-6 pb-6">
            <View
              className="gap-3"
              style={Platform.OS === 'web' ? {
                display: 'grid' as any,
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                maxWidth: 1024,
                marginHorizontal: 'auto',
              } as any : {}}
            >
              {HOME_TEMPLATES.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  isLoading={loadingTemplate === template.id}
                  onPress={() => handleTemplatePress(template)}
                />
              ))}
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  )
})

export default HomeScreen
