import { useEffect, useCallback } from 'react'
import { useRouter } from 'expo-router'
import { View, Text } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { observer } from 'mobx-react-lite'
import { useAuth } from '../../contexts/auth'
import { useProjectCollection, useWorkspaceCollection } from '../../contexts/domain'
import { ProjectListScreen, type ProjectItem } from '@shogo/shared-ui/screens'
import { Button } from '@shogo/shared-ui/primitives'

const HomeScreen = observer(function HomeScreen() {
  const router = useRouter()
  const { user, isAuthenticated } = useAuth()
  const projects = useProjectCollection()
  const workspaces = useWorkspaceCollection()

  useEffect(() => {
    if (!isAuthenticated) return
    projects.loadAll()
    workspaces.loadAll()
  }, [isAuthenticated])

  const handleCreateAgent = useCallback(async (name: string) => {
    const ws = workspaces.all[0]
    if (!ws || !user) throw new Error('No workspace available')

    await projects.create({
      name,
      workspaceId: ws.id,
      createdBy: user.id,
      tier: 'starter',
      status: 'draft',
      accessLevel: 'anyone',
      schemas: [],
      type: 'AGENT',
    })
    projects.loadAll()
  }, [workspaces.all, user, projects])

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

  const allProjects: ProjectItem[] = projects.all.slice().map((p: any) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    updatedAt: p.updatedAt,
    type: p.type || 'APP',
    status: p.status,
  }))

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ProjectListScreen
        projects={allProjects}
        isLoading={false}
        userName={user?.name ?? undefined}
        onProjectPress={(id) => router.push(`/(app)/projects/${id}`)}
        onCreateProject={handleCreateAgent}
      />
    </SafeAreaView>
  )
})

export default HomeScreen
