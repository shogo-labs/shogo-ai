import { Stack, Redirect } from 'expo-router'
import { useAuth } from '../../contexts/auth'

export default function AuthLayout() {
  const { isAuthenticated, isLoading } = useAuth()

  if (!isLoading && isAuthenticated) {
    return <Redirect href="/(app)" />
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="sign-up" />
    </Stack>
  )
}
