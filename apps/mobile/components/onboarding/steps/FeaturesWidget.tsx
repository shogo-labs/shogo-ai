// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { View, Text, Pressable } from 'react-native'
import { Bot, Wrench, MessageSquare, ArrowRight } from 'lucide-react-native'

const FEATURES = [
  {
    icon: Bot,
    title: 'AI Agents',
    description: 'Create agents that understand context and execute complex tasks.',
  },
  {
    icon: Wrench,
    title: 'Tools & Integrations',
    description: 'Connect to GitHub, Slack, databases, and more.',
  },
  {
    icon: MessageSquare,
    title: 'Chat-Driven',
    description: 'Talk to your agents in natural language.',
  },
]

interface FeaturesWidgetProps {
  onComplete: () => void
}

export function FeaturesWidget({ onComplete }: FeaturesWidgetProps) {
  return (
    <View className="gap-3">
      {FEATURES.map((f, i) => (
        <View key={i} className="flex-row gap-3 p-3 bg-card border border-border rounded-xl">
          <View className="w-9 h-9 rounded-lg bg-primary/10 items-center justify-center shrink-0">
            <f.icon size={18} className="text-primary" />
          </View>
          <View className="flex-1">
            <Text className="text-sm font-semibold text-foreground">{f.title}</Text>
            <Text className="text-xs text-muted-foreground mt-0.5 leading-4">{f.description}</Text>
          </View>
        </View>
      ))}

      <Pressable
        onPress={onComplete}
        className="flex-row items-center justify-center gap-2 bg-primary py-3 rounded-xl mt-1"
      >
        <Text className="text-sm font-semibold text-primary-foreground">Continue</Text>
        <ArrowRight size={16} color="#fff" />
      </Pressable>
    </View>
  )
}
