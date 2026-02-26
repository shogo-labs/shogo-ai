import '../polyfills'
import '../global.css'

import { useState, useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme, View, Platform } from 'react-native'
import { config } from '@/components/ui/gluestack-ui-provider/config'
import { AuthProvider } from '../contexts/auth'

export default function RootLayout() {
  const colorScheme = useColorScheme()
  const mode = colorScheme === 'dark' ? 'dark' : 'light'
  const [storageReady, setStorageReady] = useState(Platform.OS === 'web')

  useEffect(() => {
    if (Platform.OS === 'web') return
    import('../lib/auth-storage').then(({ initAuthStorage }) =>
      initAuthStorage().then(() => setStorageReady(true)),
    )
  }, [])

  if (!storageReady) return null

  return (
    <View style={[config[mode], { flex: 1 }]}>
      <AuthProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false, lazy: true }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(app)" />
          <Stack.Screen name="(admin)" />
        </Stack>
      </AuthProvider>
    </View>
  )
}
