/**
 * Admin Layout - Auth guard + Stack navigator for super admin portal.
 *
 * Checks admin role via /api/me endpoint. Redirects non-admins to home.
 */

import { useState, useEffect } from 'react'
import { View, Text, ActivityIndicator } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Shield } from 'lucide-react-native'
import { useAuth } from '../../contexts/auth'
import { API_URL } from '../../lib/api'

type UserRole = 'user' | 'super_admin'

function useAdminCheck() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth()
  const [role, setRole] = useState<UserRole | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    if (authLoading || !isAuthenticated) {
      setChecking(false)
      return
    }
    let cancelled = false
    fetch(`${API_URL}/api/me`, { credentials: 'include' })
      .then((res) => res.json())
      .then((data: any) => {
        if (!cancelled && data.ok && data.data?.role) {
          setRole(data.data.role as UserRole)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => { cancelled = true }
  }, [isAuthenticated, authLoading, user?.id])

  return {
    isSuperAdmin: role === 'super_admin',
    isPending: authLoading || checking,
    isAuthenticated,
    userEmail: user?.email,
    userName: user?.name,
  }
}

export default function AdminLayout() {
  const router = useRouter()
  const { isSuperAdmin, isPending, isAuthenticated, userEmail, userName } = useAdminCheck()

  useEffect(() => {
    if (!isPending && (!isAuthenticated || !isSuperAdmin)) {
      router.replace('/(app)')
    }
  }, [isPending, isAuthenticated, isSuperAdmin, router])

  if (isPending) {
    return (
      <SafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
          <Text className="text-muted-foreground mt-3 text-sm">
            Verifying admin access...
          </Text>
        </View>
      </SafeAreaView>
    )
  }

  if (!isAuthenticated || !isSuperAdmin) return null

  return (
    <SafeAreaView className="flex-1 bg-background">
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: 'transparent' },
          headerTintColor: '#6366f1',
          headerTitleStyle: { fontSize: 16, fontWeight: '600' },
          headerLeft: undefined,
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: 'Admin Dashboard',
            headerRight: () => (
              <View className="flex-row items-center gap-2 mr-2">
                <Text className="text-xs text-muted-foreground">
                  {userEmail}
                </Text>
                <View className="h-7 w-7 rounded-full bg-primary/10 items-center justify-center">
                  <Text className="text-xs font-medium text-primary">
                    {userName?.charAt(0)?.toUpperCase() || 'A'}
                  </Text>
                </View>
              </View>
            ),
          }}
        />
        <Stack.Screen
          name="users/index"
          options={{ title: 'Users' }}
        />
        <Stack.Screen
          name="users/[userId]"
          options={{ title: 'User Detail' }}
        />
        <Stack.Screen
          name="workspaces"
          options={{ title: 'Workspaces' }}
        />
        <Stack.Screen
          name="analytics"
          options={{ title: 'Analytics' }}
        />
      </Stack>
    </SafeAreaView>
  )
}
