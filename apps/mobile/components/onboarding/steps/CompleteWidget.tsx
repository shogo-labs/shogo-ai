// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { ArrowRight } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'

interface CompleteWidgetProps {
  onEnter: () => void
}

export function CompleteWidget({ onEnter }: CompleteWidgetProps) {
  const [isLoading, setIsLoading] = useState(false)

  const handlePress = async () => {
    setIsLoading(true)
    await onEnter()
    setIsLoading(false)
  }

  return (
    <View className="gap-3">
      <Text className="text-xs text-muted-foreground leading-4">
        You can change any of these settings later from the admin panel.
      </Text>

      <Pressable
        onPress={handlePress}
        disabled={isLoading}
        className={cn(
          'flex-row items-center justify-center gap-2 py-3.5 rounded-xl',
          isLoading ? 'bg-primary/30' : 'bg-primary'
        )}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <>
            <Text className="text-base font-semibold text-primary-foreground">Enter Shogo</Text>
            <ArrowRight size={18} color="#fff" />
          </>
        )}
      </Pressable>
    </View>
  )
}
