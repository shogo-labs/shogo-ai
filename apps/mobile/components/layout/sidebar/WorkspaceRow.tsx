// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One row for a workspace, whoever hosts it (SHO-108).
 *
 * A machine workspace is not a special kind of row: it is a workspace whose
 * host is a computer, so it draws the same colour tile, the same name, the same
 * `Personal`/`Team` badge and the same checkmark as a cloud workspace. It adds
 * exactly two things — a `Local` chip and its host as the subtitle.
 *
 * Offline hosts stay pressable. Opening one mounts the workspace and shows the
 * app's existing "can't reach <host>" state, which explains itself and recovers
 * on its own; a disabled row explains nothing.
 */

import { Pressable, Text, View } from 'react-native'
import { Check, CloudOff } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { workspaceColor, workspaceInitial } from '../../../lib/workspace-color'
import type { WorkspaceEntry, WorkspaceHost } from '../../../lib/workspace-entries'

/** "just now" / "4 min ago" / "2 h ago" / "3 d ago" — the switcher's one-liner. */
export function relativeWhen(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'no activity yet'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'no activity yet'
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} d ago`
}

/** `odin` when the host is live, `odin · Offline · last seen 4 min ago` when not. */
export function hostSubtitle(host: WorkspaceHost, now: number = Date.now()): string | null {
  if (host.kind !== 'machine') return null
  if (host.presence === 'online') return host.hostname
  const state = host.presence === 'heartbeat' ? 'Reconnecting' : 'Offline'
  const seen = host.lastSeenAt ? ` · last seen ${relativeWhen(host.lastSeenAt, now)}` : ''
  return `${host.hostname} · ${state}${seen}`
}

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
        'flex-row items-center gap-3 rounded-lg px-2 active:bg-muted',
        isNative ? 'py-3.5' : 'py-1.5',
      )}
    >
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
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-semibold text-foreground" numberOfLines={1}>
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
