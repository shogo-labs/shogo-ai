import '../polyfills'
import '../global.css'

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme } from 'react-native'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { AuthProvider } from '../contexts/auth'

export default function RootLayout() {
  const colorScheme = useColorScheme()

  return (
    <GluestackUIProvider mode={colorScheme === 'dark' ? 'dark' : 'light'}>
      <AuthProvider>
        <StatusBar style="auto" />
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
