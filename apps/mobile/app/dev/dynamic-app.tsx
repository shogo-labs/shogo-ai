import { SafeAreaView } from 'react-native-safe-area-context'
import { DynamicAppDevPreview } from '@/components/dynamic-app/DynamicAppDevPreview'

export default function DevDynamicApp() {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <DynamicAppDevPreview />
    </SafeAreaView>
  )
}
