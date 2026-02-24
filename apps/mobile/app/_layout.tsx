import '../polyfills'
import '../global.css'

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme } from 'react-native'
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider'
import { AuthProvider } from '../contexts/auth'
import { DomainProvider } from '../contexts/domain'

export default function RootLayout() {
  const colorScheme = useColorScheme()

  return (
    <GluestackUIProvider mode={colorScheme === 'dark' ? 'dark' : 'light'}>
      <AuthProvider>
        <DomainProvider>
          <StatusBar style="auto" />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(app)" />
            <Stack.Screen name="(admin)" />
          </Stack>
        </DomainProvider>
      </AuthProvider>
    </GluestackUIProvider>
  )
}
