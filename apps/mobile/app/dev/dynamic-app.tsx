import { View, Text } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

export default function DevDynamicApp() {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center p-6">
        <Text className="text-foreground text-2xl font-semibold mb-2">
          Dynamic App Preview
        </Text>
        <Text className="text-muted-foreground text-center">
          Coming soon
        </Text>
      </View>
    </SafeAreaView>
  )
}
