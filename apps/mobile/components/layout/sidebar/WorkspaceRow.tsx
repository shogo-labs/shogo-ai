// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One row for a workspace, whoever hosts it (SHO-108, SHO-285).
 *
 * A workspace hosted on a paired desktop is a normal workspace: same tile, name,
 * badge and checkmark. It adds its host as the subtitle ("Host: odin · online").
 * Offline hosts stay pressable: the workspace's rows are in the cloud either way.
 */

import { Pressable, Text, View } from 'react-native'
import { Check, CloudOff } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { workspaceColor, workspaceInitial } from '../../../lib/workspace-color'
import { hostSubtitle, relativeWhen, type WorkspaceEntry } from '../../../lib/workspace-entries'

export { hostSubtitle, relativeWhen }

export interface WorkspaceRowProps {
  entry: WorkspaceEntry
  isCurrent: boolean
  onPress: (entry: WorkspaceEntry) => void
  /**
   * Desktop local mode tags by *location* (`Local` / `Cloud`) instead of by
   * kind, because there the list mixes both. A machine row already says
   * `Local`, so it never gets a second one.
   */
  localMode?: boolean
  /** Whether this cloud entry lives in Shogo Cloud (the desktop's relay list). */
  cloudHosted?: boolean
  /** Shogo Cloud is unreachable — the cloud rows are still pressable, marked. */
  cloudUnreachable?: boolean
  /** Native phone/account density: taller row, same shape. */
  isNative?: boolean
}

const MACHINE_CHIP = 'bg-muted'
const HIGHLIGHT_CHIP = 'bg-primary/10'

export function WorkspaceRow({
  entry,
  isCurrent,
  onPress,
  localMode = false,
  cloudHosted = false,
  cloudUnreachable = false,
  isNative = false,
}: WorkspaceRowProps) {
  const machine = entry.host.kind === 'machine'
  const subtitle = hostSubtitle(entry.host)
  const kindLabel = localMode && !machine
    ? cloudHosted
      ? 'Cloud'
      : 'Local'
    : entry.kind === 'personal'
      ? 'Personal'
      : 'Team'
  const kindHighlighted = localMode && !machine ? cloudHosted : entry.kind === 'personal'

  return (
    <Pressable
      onPress={() => onPress(entry)}
      accessibilityLabel={machine ? `${entry.name} on ${entry.host.kind === 'machine' ? entry.host.hostname : entry.name}` : entry.name}
      accessibilityRole="button"
      aria-selected={isCurrent}
      testID={`workspace-row:${entry.key}`}
      className={cn(
        'flex-row items-center gap-3 active:bg-muted',
        isNative ? 'px-4 py-3' : 'rounded-lg px-2 py-1.5',
      )}
    >
      {isNative ? (
        // The check on the right marks the current workspace, so the tile stays
        // a plain 40pt square: it lines up with the action rows' tiles below.
        <View
          className="h-10 w-10 items-center justify-center rounded-xl"
          style={{ backgroundColor: workspaceColor(entry.id) }}
        >
          <Text className="text-base font-bold text-white">
            {workspaceInitial(entry.name)}
          </Text>
        </View>
      ) : (
        <View
          className={cn(
            'rounded-[14px] border-2 p-0.5',
            isCurrent ? 'border-foreground' : 'border-transparent',
          )}
        >
          <View
            className="h-9 w-9 items-center justify-center rounded-lg"
            style={{ backgroundColor: workspaceColor(entry.id) }}
          >
            <Text className="text-sm font-bold text-white">
              {workspaceInitial(entry.name)}
            </Text>
          </View>
        </View>
      )}
      <View className="min-w-0 flex-1">
        <Text
          className={cn('font-semibold text-foreground', isNative ? 'text-base' : 'text-sm')}
          numberOfLines={1}
        >
          {entry.name}
        </Text>
        <View className="mt-0.5 flex-row items-center gap-1">
          {machine && (
            <View className={cn('rounded px-1.5 py-0.5', MACHINE_CHIP)}>
              <Text className="text-[10px] text-muted-foreground">Local</Text>
            </View>
          )}
          <View className={cn('rounded px-1.5 py-0.5', kindHighlighted ? HIGHLIGHT_CHIP : MACHINE_CHIP)}>
            <Text
              className={cn(
                'text-[10px]',
                kindHighlighted ? 'font-medium text-primary' : 'text-muted-foreground',
              )}
            >
              {kindLabel}
            </Text>
          </View>
          {subtitle ? (
            <Text
              className="min-w-0 flex-1 text-[10px] text-muted-foreground"
              numberOfLines={1}
              testID={`workspace-row-host:${entry.key}`}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {entry.host.kind === 'cloud' && cloudUnreachable && (
        <CloudOff size={14} className="text-destructive" accessibilityLabel="Offline" />
      )}
      {isCurrent && (
        <Check
          size={16}
          className="text-primary"
          testID={`workspace-row-check:${entry.key}`}
          accessibilityLabel="Current workspace"
        />
      )}
    </Pressable>
  )
}
