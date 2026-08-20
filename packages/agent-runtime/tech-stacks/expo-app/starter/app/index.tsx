import { useState } from 'react'
import { SafeAreaView, ScrollView, Text, View } from 'react-native'
import { Badge } from '../src/components/ui/badge'
import { Button } from '../src/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../src/components/ui/card'

export default function Home() {
  const [count, setCount] = useState(0)

  return (
    <SafeAreaView className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-4 p-6">
        <View className="gap-1">
          <Text className="text-2xl font-bold text-foreground">Shogo Expo Starter</Text>
          <Text className="text-sm text-muted-foreground">NativeWind + Tailwind are set up</Text>
        </View>
        <Card>
          <CardHeader>
            <View className="flex-row items-center justify-between">
              <CardTitle>Tap to verify hot reload</CardTitle>
              <Badge>Ready</Badge>
            </View>
            <CardDescription>
              Style with the className prop and Tailwind utilities. Pre-installed UI
              primitives live in src/components/ui.
            </CardDescription>
          </CardHeader>
          <CardContent className="gap-2">
            <Button onPress={() => setCount((c) => c + 1)}>{`Count: ${count}`}</Button>
          </CardContent>
        </Card>
      </ScrollView>
    </SafeAreaView>
  )
}
