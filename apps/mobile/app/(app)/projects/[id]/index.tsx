import { View, Text } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams } from 'expo-router'

export default function ProjectDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()

  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center p-6">
        <Text className="text-foreground text-2xl font-semibold mb-2">
          Project View
        </Text>
        <Text className="text-muted-foreground text-center mb-2">
          Project ID: {id}
        </Text>
        <Text className="text-muted-foreground text-center">
          Coming soon
        </Text>
      </View>
    </SafeAreaView>
  )
}
