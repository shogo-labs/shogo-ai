// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View, Text } from 'react-native'
import { Check } from 'lucide-react-native'

export function FeatureList({ features }: { features: string[] }) {
  return (
    <View className="gap-2">
      {features.map((feature) => (
        <View key={feature} className="flex-row items-start gap-2">
          <Check size={14} className="text-green-500 mt-0.5" />
          <Text className="text-sm text-foreground flex-1">{feature}</Text>
        </View>
      ))}
    </View>
  )
}
