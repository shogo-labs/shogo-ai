import '../polyfills'
import '../global.css'
import '../lib/icon-interop'

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme } from 'react-native'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { AuthProvider } from '../contexts/auth'
import { ThemeProvider, useTheme } from '../contexts/theme'

function RootLayoutInner() {
  const systemColorScheme = useColorScheme()
  const { theme, isLoaded } = useTheme()

  const resolvedMode = theme === 'system'
    ? (systemColorScheme === 'dark' ? 'dark' : 'light')
    : theme

  if (!isLoaded) return null

  return (
    <GluestackUIProvider mode={resolvedMode}>
      <AuthProvider>
        <StatusBar style={resolvedMode === 'dark' ? 'light' : 'dark'} />
        <Stack screenOptions={{ headerShown: false, lazy: true }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(app)" />
          <Stack.Screen name="(admin)" />
        </Stack>
      </AuthProvider>
    </GluestackUIProvider>
  )
}

export default function RootLayout() {
  return (
    <ThemeProvider>
      <RootLayoutInner />
    </ThemeProvider>
  )
}
