// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useCallback } from 'react'
import { View, Text, Pressable, Platform } from 'react-native'
import { useUpdateChecker } from '@/lib/use-update-checker'
import { X } from 'lucide-react-native'

type DesktopUpdateStatus = 'idle' | 'available' | 'downloading' | 'ready' | 'error'
type DesktopUpdateChannel = 'stable' | 'beta'

interface DesktopUpdateStatusPayload {
  status: DesktopUpdateStatus
  releaseName: string | null
  availableVersion: string | null
  channel?: DesktopUpdateChannel
}

function useDesktopUpdateStatus() {
  const [status, setStatus] = useState<DesktopUpdateStatus>('idle')
  const [releaseName, setReleaseName] = useState<string | null>(null)
  const [availableVersion, setAvailableVersion] = useState<string | null>(null)
  const [channel, setChannel] = useState<DesktopUpdateChannel>('stable')
  const [dismissed, setDismissed] = useState(false)
  // The restart gate (SHO-181): a restart with agent runs in flight asks first,
  // and "when idle" shows the drain's live count while it waits.
  const [choice, setChoice] = useState<{ message: string; total: number } | null>(null)
  const [draining, setDraining] = useState<number | null>(null)
  const [interruptedNotice, setInterruptedNotice] = useState<string | null>(null)

  useEffect(() => {
    const desktop = typeof window !== 'undefined' ? (window as any).shogoDesktop : null
    if (!desktop?.getUpdateStatus) return

    desktop.getUpdateStatus().then((data: DesktopUpdateStatusPayload) => {
      setStatus(data.status)
      setReleaseName(data.releaseName)
      setAvailableVersion(data.availableVersion)
      if (data.channel) setChannel(data.channel)
    })

    desktop.onUpdateStatus((data: DesktopUpdateStatusPayload) => {
      setStatus(data.status)
      setReleaseName(data.releaseName)
      setAvailableVersion(data.availableVersion)
      if (data.channel) setChannel(data.channel)
      setDismissed(false)
    })

    desktop.getInterruptedNotice?.().then((data: { notice: string | null }) => {
      setInterruptedNotice(data?.notice ?? null)
    })
    desktop.onInterruptedNotice?.((data: { notice: string | null }) => {
      setInterruptedNotice(data?.notice ?? null)
    })
    desktop.onRestartDrain?.((data: { active: boolean; activity: { liveTurns: number; runningTasks: number; runningAgentReplies: number } | null }) => {
      if (!data?.active) {
        setDraining(null)
        return
      }
      const activity = data.activity
      setDraining(
        (activity?.liveTurns ?? 0) + (activity?.runningTasks ?? 0) + (activity?.runningAgentReplies ?? 0),
      )
    })

    return () => {
      desktop.removeUpdateListener?.()
      desktop.removeRestartDrainListener?.()
      desktop.removeInterruptedNoticeListener?.()
    }
  }, [])

  const download = useCallback(() => {
    const desktop = (window as any).shogoDesktop
    desktop?.downloadUpdate?.()
  }, [])

  /** Ask to restart: no mode means "tell me if runs are live first". */
  const install = useCallback(async () => {
    const desktop = (window as any).shogoDesktop
    const result = await desktop?.installUpdate?.()
    if (!result || result.ok) return
    if (result.needsChoice) {
      const activity = result.activity
      setChoice({
        message: result.message ?? 'Agent runs are still working.',
        total:
          (activity?.liveTurns ?? 0) + (activity?.runningTasks ?? 0) + (activity?.runningAgentReplies ?? 0),
      })
      return
    }
    setChoice({ message: result.error ?? 'The update could not be applied.', total: 0 })
  }, [])

  const restartNow = useCallback(() => {
    setChoice(null)
    ;(window as any).shogoDesktop?.installUpdate?.({ mode: 'now' })
  }, [])

  const restartWhenIdle = useCallback(async () => {
    setChoice(null)
    const result = await (window as any).shogoDesktop?.installUpdate?.({ mode: 'when-idle' })
    if (result && result.ok === false) {
      setChoice({ message: result.error ?? 'Could not start the restart.', total: 0 })
      return
    }
    const activity = result?.activity
    setDraining(
      (activity?.liveTurns ?? 0) + (activity?.runningTasks ?? 0) + (activity?.runningAgentReplies ?? 0),
    )
  }, [])

  const cancelRestart = useCallback(async () => {
    setChoice(null)
    if (draining !== null) {
      setDraining(null)
      await (window as any).shogoDesktop?.cancelIdleRestart?.()
    }
  }, [draining])

  // Persistent dismiss: tells the main process to stop re-broadcasting this
  // version for the rest of the session. Falls back to local hide if the
  // desktop bridge isn't available.
  const dismissAvailable = useCallback(() => {
    const desktop = (window as any).shogoDesktop
    desktop?.dismissUpdate?.()
    setDismissed(true)
  }, [])

  const dismissNotice = useCallback(() => {
    setInterruptedNotice(null)
    ;(window as any).shogoDesktop?.dismissInterruptedNotice?.()
  }, [])

  return {
    status,
    releaseName,
    availableVersion,
    channel,
    dismissed,
    setDismissed,
    download,
    install,
    dismissAvailable,
    choice,
    draining,
    restartNow,
    restartWhenIdle,
    cancelRestart,
    interruptedNotice,
    dismissNotice,
  }
}

export function UpdateBanner() {
  const { updateAvailable, dismiss: dismissWeb } = useUpdateChecker()
  const desktop = useDesktopUpdateStatus()

  const isDesktop = typeof window !== 'undefined' && !!(window as any).shogoDesktop?.isDesktop
  const showDesktopBanner =
    isDesktop &&
    (desktop.status === 'available' || desktop.status === 'downloading' || desktop.status === 'ready') &&
    !desktop.dismissed
  const showWebBanner = !isDesktop && updateAvailable && Platform.OS === 'web'
  // The one-line notice about what the *last* restart interrupted outlives the
  // update it belonged to, so it is shown on its own (SHO-181).
  const showInterruptedNotice = !!desktop.interruptedNotice

  if (!showDesktopBanner && !showWebBanner && !showInterruptedNotice) return null

  if (!showDesktopBanner && showInterruptedNotice) {
    return (
      <View
        testID="shogo-interrupted-notice"
        className="relative flex-row items-center justify-center bg-amber-600 px-8 py-1.5"
      >
        <Text className="text-xs font-medium text-white">{desktop.interruptedNotice}</Text>
        <Pressable onPress={desktop.dismissNotice} className="absolute right-2 p-1">
          <X size={12} className="text-white" />
        </Pressable>
      </View>
    )
  }

  if (showDesktopBanner) {
    const betaTag = desktop.channel === 'beta' ? (
      <View className="mr-2 rounded bg-white/20 px-1.5 py-0.5">
        <Text className="text-[10px] font-semibold uppercase text-white">Beta</Text>
      </View>
    ) : null

    // Waiting for the counts to settle: say what it is waiting for, and keep a
    // way out. Cancelling lifts the drain, so held schedules and wakes run again.
    if (desktop.draining !== null) {
      return (
        <View
          testID="shogo-update-banner-draining"
          className="relative flex-row items-center justify-center bg-brand-landing px-8 py-1.5"
        >
          <Text className="text-xs font-medium text-white">
            {desktop.draining === 0
              ? 'Restarting when idle — waiting for the last run to finish…'
              : `Restarting when idle — ${desktop.draining} agent ${desktop.draining === 1 ? 'run' : 'runs'} working`}
          </Text>
          <Pressable onPress={desktop.cancelRestart} className="ml-2 rounded bg-white/20 px-2 py-0.5">
            <Text className="text-xs font-semibold text-white">Cancel</Text>
          </Pressable>
          <Pressable onPress={desktop.restartNow} className="ml-2 rounded bg-white/20 px-2 py-0.5">
            <Text className="text-xs font-semibold text-white">Restart now</Text>
          </Pressable>
        </View>
      )
    }

    // A restart was asked for while agent runs were working: offer the choice
    // instead of killing them (SHO-181).
    if (desktop.choice && desktop.status === 'ready') {
      return (
        <View
          testID="shogo-update-banner-choice"
          className="relative flex-row flex-wrap items-center justify-center bg-brand-landing px-8 py-1.5"
        >
          <Text className="text-xs font-medium text-white">{desktop.choice.message}</Text>
          <Pressable
            onPress={desktop.restartWhenIdle}
            className="ml-2 rounded bg-white/20 px-2 py-0.5"
            testID="update-restart-when-idle"
          >
            <Text className="text-xs font-semibold text-white">Restart when idle</Text>
          </Pressable>
          <Pressable
            onPress={desktop.restartNow}
            className="ml-2 rounded bg-white/10 px-2 py-0.5"
            testID="update-restart-now"
          >
            <Text className="text-xs font-semibold text-white">Restart now</Text>
          </Pressable>
          <Pressable onPress={desktop.cancelRestart} className="absolute right-2 p-1">
            <X size={12} className="text-white" />
          </Pressable>
        </View>
      )
    }

    return (
      <View testID="shogo-update-banner" className="relative flex-row items-center justify-center bg-brand-landing px-8 py-1.5">
        {desktop.status === 'available' ? (
          <>
            {betaTag}
            <Text className="text-xs font-medium text-white">
              {desktop.availableVersion ?? 'A new version'} is available.
            </Text>
            <Pressable onPress={desktop.download} className="ml-2 rounded bg-white/20 px-2 py-0.5">
              <Text className="text-xs font-semibold text-white">Download</Text>
            </Pressable>
            <Pressable onPress={desktop.dismissAvailable} className="absolute right-2 p-1">
              <X size={12} className="text-white" />
            </Pressable>
          </>
        ) : desktop.status === 'downloading' ? (
          <>
            {betaTag}
            <Text className="text-xs font-medium text-white">Downloading update…</Text>
          </>
        ) : (
          <>
            {betaTag}
            <Text className="text-xs font-medium text-white">
              {desktop.releaseName ?? 'A new version'} is ready to install.
            </Text>
            <Pressable onPress={desktop.install} className="ml-2 rounded bg-white/20 px-2 py-0.5">
              <Text className="text-xs font-semibold text-white">Restart</Text>
            </Pressable>
            <Pressable onPress={() => desktop.setDismissed(true)} className="absolute right-2 p-1">
              <X size={12} className="text-white" />
            </Pressable>
          </>
        )}
      </View>
    )
  }

  return (
    <View className="relative flex-row items-center justify-center bg-brand-landing px-8 py-1.5">
      <Text className="text-xs font-medium text-white">
        A new version is available.
      </Text>
      <Pressable
        onPress={() => {
          if (typeof window !== 'undefined') window.location.reload()
        }}
        className="ml-2 rounded bg-white/20 px-2 py-0.5"
      >
        <Text className="text-xs font-semibold text-white">Refresh</Text>
      </Pressable>
      <Pressable onPress={dismissWeb} className="absolute right-2 p-1">
        <X size={12} className="text-white" />
      </Pressable>
    </View>
  )
}
