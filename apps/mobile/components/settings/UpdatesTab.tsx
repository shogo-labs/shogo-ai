// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Updates. Desktop-only (see `desktopOnly` in settings-tabs.ts):
 * lets the user opt into the `beta` update channel, which tracks the
 * newest manually published signed prerelease instead of the latest tagged
 * stable release. See `apps/desktop/src/updater.ts` +
 * `update-channel.ts` for the feed-resolution side of this.
 */
import { useState, useEffect, useCallback } from 'react'
import { View, ScrollView, ActivityIndicator, Pressable } from 'react-native'
import {
  RefreshCw as RefreshCwIcon,
  CheckCircle2 as CheckCircle2Icon,
  AlertCircle as AlertCircleIcon,
} from 'lucide-react-native'
import { Card, CardContent, Button, Badge, cn } from '@shogo/shared-ui/primitives'
import { Text, useAccountSheetIcons } from './account-sheet-chrome'

type UpdateChannel = 'stable' | 'beta'
type UpdateStatus = 'idle' | 'available' | 'downloading' | 'ready' | 'error'

interface UpdateStatusPayload {
  status: UpdateStatus
  releaseName: string | null
  availableVersion: string | null
  channel?: UpdateChannel
}

interface ShogoDesktopUpdates {
  getSystemInfo?: () => Promise<Record<string, unknown>>
  getUpdateChannel: () => Promise<{ channel: UpdateChannel }>
  setUpdateChannel: (channel: UpdateChannel) => Promise<{ ok: boolean; channel?: UpdateChannel; error?: string }>
  checkForUpdates: () => Promise<{ ok: boolean; error?: string }>
  getUpdateStatus: () => Promise<UpdateStatusPayload>
  onUpdateStatus: (callback: (data: UpdateStatusPayload) => void) => void
  removeUpdateListener?: () => void
}

function getShogoDesktop(): ShogoDesktopUpdates | null {
  if (typeof window !== 'undefined' && (window as any).shogoDesktop) {
    return (window as any).shogoDesktop
  }
  return null
}

const STATUS_LABEL: Record<Exclude<UpdateStatus, 'idle' | 'error'>, string> = {
  available: 'update available',
  downloading: 'downloading…',
  ready: 'ready to install',
}

export function UpdatesTab() {
  const { RefreshCw, CheckCircle2, AlertCircle } = useAccountSheetIcons({
    RefreshCw: RefreshCwIcon,
    CheckCircle2: CheckCircle2Icon,
    AlertCircle: AlertCircleIcon,
  })

  const desktop = getShogoDesktop()
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [channel, setChannel] = useState<UpdateChannel>('stable')
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)
  const [releaseName, setReleaseName] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!desktop) return

    desktop.getSystemInfo?.().then((info) => {
      const version = info?.appVersion
      if (typeof version === 'string') setAppVersion(version)
    })

    desktop.getUpdateChannel().then((res) => setChannel(res.channel))

    desktop.getUpdateStatus().then((data) => {
      setStatus(data.status)
      setAvailableVersion(data.availableVersion)
      setReleaseName(data.releaseName)
      if (data.channel) setChannel(data.channel)
    })

    desktop.onUpdateStatus((data) => {
      setStatus(data.status)
      setAvailableVersion(data.availableVersion)
      setReleaseName(data.releaseName)
      if (data.channel) setChannel(data.channel)
    })

    return () => desktop.removeUpdateListener?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectChannel = useCallback(
    async (next: UpdateChannel) => {
      if (!desktop || next === channel || switching) return
      setSwitching(true)
      setError(null)
      try {
        const res = await desktop.setUpdateChannel(next)
        if (res.ok) {
          setChannel(res.channel ?? next)
        } else {
          setError(res.error || 'Could not switch update channel — try again once the current update finishes.')
        }
      } catch (err: any) {
        setError(err?.message || 'Could not switch update channel')
      } finally {
        setSwitching(false)
      }
    },
    [desktop, channel, switching],
  )

  const handleCheck = useCallback(async () => {
    if (!desktop) return
    setChecking(true)
    setError(null)
    try {
      await desktop.checkForUpdates()
    } catch (err: any) {
      setError(err?.message || 'Could not check for updates')
    } finally {
      // The probe result arrives async over `onUpdateStatus`; give it a
      // moment to land before dropping the spinner.
      setTimeout(() => setChecking(false), 1500)
    }
  }, [desktop])

  if (!desktop) {
    return (
      <View className="flex-1 items-center justify-center p-8">
        <Text className="text-muted-foreground text-center">
          Update settings are only available in the desktop app.
        </Text>
      </View>
    )
  }

  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 24, gap: 20 }}>
      <View className="gap-1">
        <Text className="text-xl font-semibold text-foreground">Updates</Text>
        <Text className="text-sm text-muted-foreground">
          Choose which builds Shogo should offer to install.
        </Text>
      </View>

      <Card>
        <CardContent className="p-4 gap-2">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-medium text-foreground">Current version</Text>
            <Text className="text-sm text-muted-foreground font-mono">
              {appVersion ? `v${appVersion}` : '—'}
            </Text>
          </View>
          {status !== 'idle' && status !== 'error' && (
            <Text className="text-xs text-muted-foreground">
              {status === 'available' && `${availableVersion ?? 'A new version'} is available.`}
              {status === 'downloading' && 'Downloading update…'}
              {status === 'ready' && `${releaseName ?? 'A new version'} is ready to install. Restart to apply it.`}
            </Text>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 gap-3">
          <Text className="text-sm font-medium text-foreground">Update channel</Text>

          <Pressable
            testID="shogo-update-channel-stable"
            onPress={() => selectChannel('stable')}
            disabled={switching}
            className={cn(
              'flex-row items-start gap-3 rounded-md border p-3',
              channel === 'stable' ? 'border-primary bg-muted' : 'border-input',
            )}
          >
            <View className="flex-1 gap-0.5">
              <Text className="text-sm font-medium text-foreground">Stable</Text>
              <Text className="text-xs text-muted-foreground">
                The latest tagged release. Recommended for everyday use.
              </Text>
            </View>
            {channel === 'stable' && <CheckCircle2 size={16} color="#22c55e" />}
          </Pressable>

          <Pressable
            testID="shogo-update-channel-beta"
            onPress={() => selectChannel('beta')}
            disabled={switching}
            className={cn(
              'flex-row items-start gap-3 rounded-md border p-3',
              channel === 'beta' ? 'border-primary bg-muted' : 'border-input',
            )}
          >
            <View className="flex-1 gap-1">
              <View className="flex-row items-center gap-2">
                <Text className="text-sm font-medium text-foreground">Beta</Text>
                <Badge variant="secondary">manual</Badge>
              </View>
              <Text className="text-xs text-muted-foreground">
                Tracks the newest manually published beta build from the selected commit. May be unstable.
                Switching back to Stable keeps this build installed until a newer stable
                release is published.
              </Text>
            </View>
            {channel === 'beta' && <CheckCircle2 size={16} color="#22c55e" />}
          </Pressable>

          {switching && (
            <View className="flex-row items-center gap-2">
              <ActivityIndicator size="small" />
              <Text className="text-xs text-muted-foreground">Switching channel…</Text>
            </View>
          )}
        </CardContent>
      </Card>

      {error && (
        <View
          testID="shogo-update-error"
          className="w-full flex-row items-start gap-2 rounded-lg border border-destructive bg-destructive/10 p-4"
        >
          <AlertCircle size={16} color="#ef4444" style={{ marginTop: 2 }} />
          <Text className="flex-1 text-sm text-destructive">{error}</Text>
        </View>
      )}

      <Button
        testID="shogo-update-check"
        variant="outline"
        className="flex-row items-center justify-center gap-2"
        onPress={handleCheck}
        disabled={checking}
      >
        {checking ? <ActivityIndicator size="small" /> : <RefreshCw size={16} color="#6b7280" />}
        <Text className="text-sm font-medium text-foreground">
          {checking ? 'Checking…' : 'Check for updates'}
        </Text>
      </Button>

      {status !== 'idle' && status !== 'error' && (
        <Text testID="shogo-update-status" className="text-center text-xs text-muted-foreground">
          {STATUS_LABEL[status]}
        </Text>
      )}
    </ScrollView>
  )
}
