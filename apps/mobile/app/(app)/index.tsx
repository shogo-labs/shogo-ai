import { useState, useEffect, useCallback } from 'react'
import { View, Text } from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import { useAuth } from '../../contexts/auth'
import { useProjectCollection, useWorkspaceCollection } from '../../contexts/domain'
import { Button } from '@shogo/shared-ui/primitives'
import { HomePage } from '../../components/home/HomePage'

const HomeScreen = observer(function HomeScreen() {
  const router = useRouter()
  const { user, isAuthenticated } = useAuth()
  const projects = useProjectCollection()
  const workspaces = useWorkspaceCollection()
  const [isCreating, setIsCreating] = useState(false)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)

  useEffect(() => {
    if (!isAuthenticated) return
    projects.loadAll()
    workspaces.loadAll()
  }, [isAuthenticated])

  const handlePromptSubmit = useCallback(async (prompt: string, _imageData?: string[]) => {
    const ws = workspaces.all[0]
    if (!ws || !user) return

    setIsCreating(true)
    try {
      const project = await projects.create({
        name: prompt.slice(0, 60),
        workspaceId: ws.id,
        createdBy: user.id,
        tier: 'starter',
        status: 'draft',
        accessLevel: 'anyone',
        schemas: [],
        type: 'AGENT',
      })
      if (project?.id) {
        router.push(`/(app)/projects/${project.id}`)
      }
    } finally {
      setIsCreating(false)
    }
  }, [workspaces.all, user, projects, router])

  const handleTemplateSelect = useCallback(async (
    templateName: string,
    displayName: string,
    prompt: string,
  ) => {
    const ws = workspaces.all[0]
    if (!ws || !user) return

    setLoadingTemplate(templateName)
    try {
      const project = await projects.create({
        name: displayName,
        workspaceId: ws.id,
        createdBy: user.id,
        tier: 'starter',
        status: 'draft',
        accessLevel: 'anyone',
        schemas: [],
        type: 'AGENT',
      })
      if (project?.id) {
        router.push(`/(app)/projects/${project.id}`)
      }
    } finally {
      setLoadingTemplate(null)
    }
  }, [workspaces.all, user, projects, router])

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
    <HomePage
      userName={user?.name ?? undefined}
      onPromptSubmit={handlePromptSubmit}
      onTemplateSelect={handleTemplateSelect}
      isLoading={isCreating}
      loadingTemplate={loadingTemplate}
    />
  )
})

export default HomeScreen
