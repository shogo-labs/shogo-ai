// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CloudSyncStatusPill — live content-sync indicator for the project header.
 *
 * Polls `GET /api/local/cloud-projects/:id/sync-status` and renders a small
 * colored pill reflecting the project's cloud-content-sync state
 * (pulling / watching / pushing / error / offline) plus a one-writer
 * conflict warning when present. Press it for details (last sync time,
 * transport mode, error, warning).
 *
 * Self-gating: renders nothing unless we're in the desktop/local build
 * (`localMode`) AND the backend reports the project is cloud-linked. It
 * fetches once for any project and only keeps polling for cloud-linked
 * ones, so local-only projects cost a single request and then go quiet.
 */
import React, { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import {
  Cloud,
  CloudOff,
  CloudDownload,
  CloudUpload,
  Check,
  AlertTriangle,
} from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { Text } from '@/components/ui/text'
import { Popover, PopoverBackdrop, PopoverContent, PopoverBody } from '../ui/popover'
import { useDomainHttp } from '../../contexts/domain'
import { usePlatformConfig } from '../../lib/platform-config'
import { api, type CloudSyncStatusDTO, type CloudSyncState } from '../../lib/api'

const POLL_MS = 5_000

type IconType = React.ComponentType<{ size?: number; className?: string }>

interface Visual {
  label: string
  icon?: IconType
  spinning?: boolean
  /** Tailwind text color for the icon + label. */
  text: string
  /** Tailwind background tint for the pill. */
  bg: string
}

function visualFor(state: CloudSyncState): Visual {
  switch (state) {
    case 'pulling':
      return { label: 'Pulling…', icon: CloudDownload, spinning: true, text: 'text-primary-600', bg: 'bg-primary-500/10' }
    case 'pushing':
      return { label: 'Syncing…', icon: CloudUpload, spinning: true, text: 'text-primary-600', bg: 'bg-primary-500/10' }
    case 'watching':
      return { label: 'Synced', icon: Cloud, text: 'text-emerald-600', bg: 'bg-emerald-500/10' }
    case 'offline':
      return { label: 'Offline', icon: CloudOff, text: 'text-amber-600', bg: 'bg-amber-500/10' }
    case 'error':
      return { label: 'Sync error', icon: AlertTriangle, text: 'text-red-600', bg: 'bg-red-500/10' }
    case 'idle':
    default:
      return { label: 'Cloud', icon: Cloud, text: 'text-muted-foreground', bg: 'bg-muted' }
  }
}

function relativeTime(ms?: number): string | null {
  if (!ms || !Number.isFinite(ms)) return null
  const diff = Date.now() - ms
  if (diff < 0) return null
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function CloudSyncStatusPill({ projectId }: { projectId: string }) {
  const http = useDomainHttp()
  const { localMode } = usePlatformConfig()
  const [data, setData] = useState<
    { cloudLinked: boolean; status: CloudSyncStatusDTO } | null
  >(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  // Poll while cloud-linked. A non-linked project fetches once and stops.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    if (!localMode || !projectId) {
      setData(null)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const res = await api.getCloudSyncStatus(http, projectId)
      if (!aliveRef.current) return
      setData(res)
      if (res?.cloudLinked) {
        timer = setTimeout(tick, POLL_MS)
      }
    }
    void tick()
    return () => {
      aliveRef.current = false
      if (timer) clearTimeout(timer)
    }
  }, [http, projectId, localMode])

  if (!localMode || !data?.cloudLinked) return null

  const { status } = data
  const v = visualFor(status.state)
  const lastSynced = relativeTime(status.lastPushAt)
  const hasConflict = !!status.conflictWarning

  return (
    <Popover
      placement="bottom"
      size="sm"
      isOpen={detailsOpen}
      onOpen={() => setDetailsOpen(true)}
      onClose={() => setDetailsOpen(false)}
      trigger={(triggerProps) => (
        <Pressable
          {...triggerProps}
          onPress={() => setDetailsOpen((o) => !o)}
          accessibilityLabel={`Cloud sync: ${v.label}`}
          testID="cloud-sync-status-pill"
          className={cn('ml-1 flex-row items-center gap-1 rounded-full px-2 py-0.5', v.bg)}
        >
          {v.spinning ? (
            <ActivityIndicator size="small" />
          ) : v.icon ? (
            <v.icon size={12} className={v.text} />
          ) : null}
          <Text className={cn('text-[11px] font-medium', v.text)}>{v.label}</Text>
          {hasConflict && <AlertTriangle size={11} className="text-amber-600" />}
        </Pressable>
      )}
    >
      <PopoverBackdrop />
      <PopoverContent className="w-[280px] p-0">
        <PopoverBody>
          <View className="gap-2 p-3">
            <View className="flex-row items-center gap-2">
              {v.icon && <v.icon size={14} className={v.text} />}
              <Text className={cn('text-sm font-semibold', v.text)}>{v.label}</Text>
              {status.mode && (
                <Text className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {status.mode}
                </Text>
              )}
            </View>

            <Text className="text-xs text-muted-foreground leading-relaxed">
              Files sync to the cloud automatically while this project is open.
            </Text>

            {lastSynced && (
              <View className="flex-row items-center gap-1.5">
                <Check size={12} className="text-emerald-600" />
                <Text className="text-xs text-foreground">Last synced {lastSynced}</Text>
              </View>
            )}

            {status.state === 'error' && status.lastError && (
              <View className="rounded-md bg-red-500/10 p-2">
                <Text className="text-[11px] text-red-600 leading-relaxed">{status.lastError}</Text>
              </View>
            )}

            {status.state === 'offline' && (
              <Text className="text-[11px] text-amber-600 leading-relaxed">
                Can't reach the cloud. Your edits stay local and will sync when the connection returns.
              </Text>
            )}

            {hasConflict && (
              <View className="flex-row items-start gap-1.5 rounded-md bg-amber-500/10 p-2">
                <AlertTriangle size={12} className="mt-0.5 text-amber-600" />
                <Text className="flex-1 text-[11px] text-amber-700 leading-relaxed">
                  {status.conflictWarning}
                </Text>
              </View>
            )}
          </View>
        </PopoverBody>
      </PopoverContent>
    </Popover>
  )
}
