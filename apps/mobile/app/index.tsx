import { Redirect } from 'expo-router'
import { useAuth } from '../contexts/auth'

export default function RootIndex() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) return null

  if (isAuthenticated) {
    return <Redirect href="/(app)" />
  }

  return <Redirect href="/(auth)/sign-in" />
}
