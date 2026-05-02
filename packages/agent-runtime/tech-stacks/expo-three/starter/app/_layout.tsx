import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GameProvider } from '@/lib/store'

export default function RootLayout() {
  return (
    <GameProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#05060b' } }} />
    </GameProvider>
  )
}
