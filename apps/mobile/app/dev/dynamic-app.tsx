import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'
import { DynamicAppDevPreview } from '@/components/dynamic-app/DynamicAppDevPreview'

export default function DevDynamicApp() {
  const { agentUrl } = useLocalSearchParams<{ agentUrl?: string }>()

  return (
    <SafeAreaView className="flex-1 bg-background">
      <DynamicAppDevPreview agentUrl={agentUrl} />
    </SafeAreaView>
  )
}
