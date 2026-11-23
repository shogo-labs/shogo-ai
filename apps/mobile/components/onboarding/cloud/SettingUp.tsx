// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Text, View } from 'react-native'
import { TriangleAlert } from 'lucide-react-native'
import { Button } from '@shogo/shared-ui/primitives'
import { ShogoWordmark } from '../../branding/ShogoWordmark'
import { Spinner } from '@/components/ui/spinner'

interface SettingUpProps {
  message: string
  error?: string | null
  onRetry: () => void
  onContinueAnyway: () => void
}

/**
 * Terminal state shown while onboarding's completion work runs. Navigates
 * away on success, so it only needs buttons when something failed.
 */
export function SettingUp({ message, error, onRetry, onContinueAnyway }: SettingUpProps) {
  return (
    <View className="flex-1 items-center justify-center bg-background px-6">
      <View className="w-full max-w-sm items-center gap-6">
        <ShogoWordmark className="h-8 w-32" />
        {error ? (
          <>
            <View className="items-center gap-3">
              <TriangleAlert size={28} className="text-destructive" />
              <Text className="text-center text-base font-semibold text-foreground">
                Something went wrong
              </Text>
              <Text className="text-center text-sm leading-5 text-muted-foreground">{error}</Text>
            </View>
            <View className="w-full gap-2">
              <Button size="lg" className="w-full rounded-xl" onPress={onRetry}>
                Try again
              </Button>
              <Button variant="ghost" className="w-full" onPress={onContinueAnyway}>
                Continue anyway
              </Button>
            </View>
          </>
        ) : (
          <View className="items-center gap-4" accessibilityLiveRegion="polite">
            <Spinner tone="muted" size="small" />
            <Text className="text-center text-base text-muted-foreground">{message}</Text>
          </View>
        )}
      </View>
    </View>
  )
}
