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
import { View, ScrollView, Pressable } from 'react-native'
import {
  RefreshCw as RefreshCwIcon,
  CheckCircle2 as CheckCircle2Icon,
  AlertCircle as AlertCircleIcon,
  Download as DownloadIcon,
  RotateCw as RotateCwIcon,
} from 'lucide-react-native'
import { Card, CardContent, Button, Badge, cn } from '@shogo/shared-ui/primitives'
import { Text, useAccountSheetIcons } from './account-sheet-chrome'
import {
  useDesktopUpdateStatus,
  type DesktopUpdateChannel,
  type DesktopUpdateStatus,
  type DesktopUpdateStatusPayload,
} from '@/lib/use-desktop-update'
import { Spinner } from '@/components/ui/spinner'

type UpdateChannel = DesktopUpdateChannel
type UpdateStatus = DesktopUpdateStatus

interface ShogoDesktopUpdates {
  getSystemInfo?: () => Promise<Record<string, unknown>>
  getUpdateChannel: () => Promise<{ channel: UpdateChannel }>
  setUpdateChannel: (channel: UpdateChannel) => Promise<{ ok: boolean; channel?: UpdateChannel; error?: string }>
  checkForUpdates: () => Promise<{ ok: boolean; error?: string }>
  getUpdateStatus: () => Promise<DesktopUpdateStatusPayload>
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
  const { RefreshCw, CheckCircle2, AlertCircle, Download, RotateCw } = useAccountSheetIcons({
    RefreshCw: RefreshCwIcon,
    CheckCircle2: CheckCircle2Icon,
    AlertCircle: AlertCircleIcon,
    Download: DownloadIcon,
    RotateCw: RotateCwIcon,
  })

  // The lifecycle and both of its actions come from the hook shared with the
  // banner. Download and Restart used to exist only on the banner, so dismissing
  // it left no way to install this session (SHO-510).
  const update = useDesktopUpdateStatus()
  const { status, availableVersion, releaseName } = update

  const desktop = getShogoDesktop()
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [channel, setChannel] = useState<UpdateChannel>('stable')
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
    // The update status itself — and the actions that go with it — come from the
    // shared hook, which unsubscribes only its own listener. This tab used to
    // clear every listener on the channel as it unmounted, which silenced the
    // banner for the rest of the session.
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

  // A download or install failure belongs in the page's existing error box,
  // next to the retry — never swallowed (SHO-510). The specific action's reason
  // comes first: a stale "Could not switch update channel" must not hide why the
  // download the person just pressed failed.
  const pageError = update.downloadError ?? update.installError ?? error

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
        <CardContent className="p-4 gap-3">
          <View className="flex-row items-center justify-between">
            <Text className="text-sm font-medium text-foreground">Current version</Text>
            <Text className="text-sm text-muted-foreground font-mono">
              {appVersion ? `v${appVersion}` : '—'}
            </Text>
          </View>

          {status !== 'idle' && status !== 'error' && (
            <Text testID="shogo-update-line" className="text-xs text-muted-foreground">
              {status === 'available' && `${availableVersion ?? 'A new version'} is available.`}
              {status === 'downloading' && 'Downloading update…'}
              {status === 'ready' && `${releaseName ?? 'A new version'} is ready to install. Restart to apply it.`}
            </Text>
          )}

          {/* Download, then the same SHO-181 restart gate the banner uses — so
              the page can install the version even with the banner dismissed. */}
          {(status === 'available' || status === 'downloading') && (
            <View className="flex-row items-center gap-2">
              <Button
                testID="shogo-update-download"
                variant="outline"
                size="sm"
                className="flex-row items-center justify-center gap-2"
                onPress={update.download}
                disabled={status === 'downloading'}
              >
                {status === 'downloading' ? (
                  <Spinner size="small" />
                ) : (
                  <Download className="text-muted-foreground" size={16} />
                )}
                <Text className="text-sm font-medium text-foreground">Download</Text>
              </Button>
              {channel === 'beta' && <Badge variant="secondary">Beta</Badge>}
            </View>
          )}

          {status === 'ready' && update.draining !== null && (
            <View testID="shogo-update-restart-draining" className="gap-2">
              <Text className="text-xs text-muted-foreground">
                {update.draining === 0
                  ? 'Restarting when idle — waiting for the last run to finish…'
                  : `Restarting when idle — ${update.draining} agent ${update.draining === 1 ? 'run' : 'runs'} working`}
              </Text>
              <View className="flex-row flex-wrap items-center gap-2">
                <Button
                  testID="shogo-update-restart-cancel"
                  variant="outline"
                  size="sm"
                  onPress={update.cancelRestart}
                >
                  <Text className="text-sm font-medium text-foreground">Cancel</Text>
                </Button>
                <Button
                  testID="shogo-update-restart-now"
                  variant="outline"
                  size="sm"
                  onPress={update.restartNow}
                >
                  <Text className="text-sm font-medium text-foreground">Restart now</Text>
                </Button>
              </View>
            </View>
          )}

          {status === 'ready' && update.draining === null && update.choice && (
            <View testID="shogo-update-restart-choice" className="gap-2">
              <Text className="text-xs text-muted-foreground">{update.choice.message}</Text>
              <View className="flex-row flex-wrap items-center gap-2">
                <Button
                  testID="shogo-update-restart-when-idle"
                  variant="outline"
                  size="sm"
                  onPress={update.restartWhenIdle}
                >
                  <Text className="text-sm font-medium text-foreground">Restart when idle</Text>
                </Button>
                <Button
                  testID="shogo-update-restart-now"
                  variant="outline"
                  size="sm"
                  onPress={update.restartNow}
                >
                  <Text className="text-sm font-medium text-foreground">Restart now</Text>
                </Button>
                <Button
                  testID="shogo-update-restart-cancel"
                  variant="ghost"
                  size="sm"
                  onPress={update.cancelRestart}
                >
                  <Text className="text-sm font-medium text-foreground">Cancel</Text>
                </Button>
              </View>
            </View>
          )}

          {status === 'ready' && update.draining === null && !update.choice && (
            <Button
              testID="shogo-update-restart"
              variant="outline"
              className="flex-row items-center justify-center gap-2"
              onPress={update.install}
            >
              <RotateCw className="text-muted-foreground" size={16} />
              <Text className="text-sm font-medium text-foreground">Restart to update</Text>
            </Button>
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
              <Spinner size="small" />
              <Text className="text-xs text-muted-foreground">Switching channel…</Text>
            </View>
          )}
        </CardContent>
      </Card>

      {pageError && (
        <View
          testID="shogo-update-error"
          className="w-full flex-row items-start gap-2 rounded-lg border border-destructive bg-destructive/10 p-4"
        >
          <AlertCircle size={16} color="#ef4444" style={{ marginTop: 2 }} />
          <Text className="flex-1 text-sm text-destructive">{pageError}</Text>
        </View>
      )}

      <Button
        testID="shogo-update-check"
        variant="outline"
        className="flex-row items-center justify-center gap-2"
        onPress={handleCheck}
        disabled={checking}
      >
        {checking ? <Spinner className="text-muted-foreground" size="small" /> : <RefreshCw size={16} />}
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
