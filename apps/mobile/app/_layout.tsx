import '../polyfills'
import '../global.css'

import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useColorScheme, View } from 'react-native'
import { config } from '@/components/ui/gluestack-ui-provider/config'
import { AuthProvider } from '../contexts/auth'

export default function RootLayout() {
  const colorScheme = useColorScheme()
  const mode = colorScheme === 'dark' ? 'dark' : 'light'

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
