// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useEffect } from 'react'
import { Text, View } from 'react-native'
import { Monitor, MousePointerClick } from 'lucide-react-native'
import { Button } from '@shogo/shared-ui/primitives'
import type { PermissionStatus } from '../../../lib/desktop-bridge'
import { useOsPermissions } from '../../../lib/use-os-permissions'
import { PermissionRow } from './PermissionRow'

interface ComputerUseStepProps {
  onStatusChange?: (status: PermissionStatus) => void
}

/** Accessibility + Screen Recording: what the agent needs to see and drive the computer. */
export function ComputerUseStep({ onStatusChange }: ComputerUseStepProps) {
  const perms = useOsPermissions()
  const { status, requesting, awaitingSettings } = perms

  useEffect(() => {
    if (perms.ready) onStatusChange?.(status)
  }, [status, perms.ready, onStatusChange])

  const accessibilityDescription =
    status.accessibility === 'granted'
      ? 'Allow Shogo to click and type for you'
      : awaitingSettings.accessibility
        ? 'Turn Shogo on in System Settings, then come back here'
        : 'Turned off in System Settings'

  const needsRestart = awaitingSettings.screen && status.screen !== 'granted'

  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card">
      <PermissionRow
        id="accessibility"
        title="Accessibility"
        description={accessibilityDescription}
        icon={MousePointerClick}
        state={status.accessibility}
        busy={requesting === 'accessibility'}
        onAllow={() => void perms.request('accessibility')}
      />
      <View className="h-px bg-border" />
      <PermissionRow
        id="screen"
        title="Screen Recording"
        description="Allow Shogo to take screenshots"
        icon={Monitor}
        state={status.screen}
        busy={requesting === 'screen'}
        onAllow={() => void perms.request('screen')}
      >
        {needsRestart ? (
          <View className="mt-2 gap-2">
            <Text className="text-xs leading-4 text-muted-foreground">
              After turning Shogo on, macOS needs Shogo to restart before screenshots work.
            </Text>
            <View className="flex-row">
              <Button
                testID="permission-relaunch"
                size="sm"
                variant="outline"
                className="rounded-full"
                onPress={() => void perms.relaunch()}
              >
                Restart Shogo
              </Button>
            </View>
          </View>
        ) : null}
      </PermissionRow>
    </View>
  )
}

export function ComputerUseFootnote() {
  return (
    <Text className="text-center text-xs leading-4 text-muted-foreground">
      You can manage computer use permissions any time in Settings. Shogo only controls your computer when you ask it
      to, and you can stop it at any time.
    </Text>
  )
}
