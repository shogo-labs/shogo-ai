// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The desktop update lifecycle, shared by the top banner
 * (`components/UpdateBanner.tsx`) and Settings → Updates
 * (`components/settings/UpdatesTab.tsx`).
 *
 * Both surfaces show the same three states — available → downloading → ready —
 * and both need the same two actions: Download, then Restart (through the
 * SHO-181 gate that asks before it interrupts live agent runs). Living here
 * rather than in the banner is what lets the Updates page install a version
 * the banner was dismissed for this session (SHO-510).
 *
 * **Each consumer unsubscribes only its own listener.** The preload returns a
 * per-listener unsubscribe for every channel this hook uses; an older preload
 * that returns nothing falls back to the shared `remove*Listener` helper. The
 * fallback is the old behaviour: it clears every listener on the channel, which
 * is exactly how the Updates tab used to silence the banner when it unmounted.
 */
import { useCallback, useEffect, useState } from 'react'

export type DesktopUpdateStatus = 'idle' | 'available' | 'downloading' | 'ready' | 'error'
export type DesktopUpdateChannel = 'stable' | 'beta'

export interface DesktopUpdateStatusPayload {
  status: DesktopUpdateStatus
  releaseName: string | null
  availableVersion: string | null
  channel?: DesktopUpdateChannel
  /**
   * Why a user-started download failed, when it did. The updater sets it while
   * handing the status back to `available` so the retry is offered next to the
   * reason; the next download, check or status change clears it.
   */
  error?: string | null
}

export interface DesktopLiveActivity {
  agentRuns: number
  backgroundCommands: number
}

export interface DesktopInstallResult {
  ok: boolean
  mode?: 'now' | 'when-idle' | 'immediate'
  needsChoice?: boolean
  message?: string
  activity?: DesktopLiveActivity | null
  error?: string
}

type Unsubscribe = () => void
type Subscribe<T> = (callback: (data: T) => void) => Unsubscribe | void

interface DesktopUpdateBridge {
  getUpdateStatus?: () => Promise<DesktopUpdateStatusPayload>
  onUpdateStatus?: Subscribe<DesktopUpdateStatusPayload>
  removeUpdateListener?: () => void
  downloadUpdate?: () => Promise<{ ok: boolean; error?: string }>
  dismissUpdate?: () => Promise<unknown>
  installUpdate?: (options?: { mode?: 'now' | 'when-idle' }) => Promise<DesktopInstallResult>
  cancelIdleRestart?: () => Promise<{ ok: boolean; cancelled?: boolean }>
  onRestartDrain?: Subscribe<{ active: boolean; activity: DesktopLiveActivity | null }>
  removeRestartDrainListener?: () => void
  getInterruptedNotice?: () => Promise<{ notice: string | null }>
  dismissInterruptedNotice?: () => Promise<unknown>
  onInterruptedNotice?: Subscribe<{ notice: string | null }>
  removeInterruptedNoticeListener?: () => void
}

function getBridge(): DesktopUpdateBridge | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { shogoDesktop?: DesktopUpdateBridge }).shogoDesktop ?? null
}

/**
 * Subscribe, and hand back the unsubscribe for **this** listener only. A preload
 * from before SHO-510 returns nothing from these calls; there the shared remove
 * helper is the only cleanup it offers, so fall back to it rather than leaking.
 */
function subscribe<T>(
  start: Subscribe<T> | undefined,
  removeAll: (() => void) | undefined,
  callback: (data: T) => void,
): Unsubscribe {
  if (!start) return () => {}
  const own = start(callback)
  if (typeof own === 'function') return own
  return () => {
    removeAll?.()
  }
}

export interface DesktopUpdate {
  status: DesktopUpdateStatus
  releaseName: string | null
  availableVersion: string | null
  channel: DesktopUpdateChannel
  /** Locally hidden: the banner's X, or the banner's local dismiss. */
  dismissed: boolean
  setDismissed: (dismissed: boolean) => void
  download: () => Promise<void>
  /** Ask to restart: no mode means "tell me if runs are live first". */
  install: () => Promise<void>
  restartNow: () => void
  restartWhenIdle: () => Promise<void>
  cancelRestart: () => Promise<void>
  dismissAvailable: () => void
  choice: { message: string; total: number } | null
  /** Live agent runs while a "restart when idle" waits; null when not waiting. */
  draining: number | null
  interruptedNotice: string | null
  dismissNotice: () => void
  /** `{ ok:false, error }` from a download, plus the updater's error broadcast. */
  downloadError: string | null
  /** `{ ok:false, error }` from an install. */
  installError: string | null
}

export function useDesktopUpdateStatus(): DesktopUpdate {
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
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)

  useEffect(() => {
    const desktop = getBridge()
    if (!desktop?.getUpdateStatus) return

    const applyStatus = (data: DesktopUpdateStatusPayload) => {
      setStatus(data.status)
      setReleaseName(data.releaseName)
      setAvailableVersion(data.availableVersion)
      if (data.channel) setChannel(data.channel)
      // A download that failed comes back as `available` with a reason. Show it
      // beside the retry; the next download, check or status change clears it.
      setDownloadError(data.error ?? null)
    }

    desktop.getUpdateStatus().then(applyStatus).catch(() => {})

    const unsubscribes: Unsubscribe[] = [
      subscribe(desktop.onUpdateStatus, desktop.removeUpdateListener, (data) => {
        applyStatus(data)
        setDismissed(false)
      }),
      subscribe(desktop.onInterruptedNotice, desktop.removeInterruptedNoticeListener, (data) => {
        setInterruptedNotice(data?.notice ?? null)
      }),
      subscribe(desktop.onRestartDrain, desktop.removeRestartDrainListener, (data) => {
        if (!data?.active) {
          setDraining(null)
          return
        }
        setDraining(data.activity?.agentRuns ?? 0)
      }),
    ]

    desktop.getInterruptedNotice?.().then((data) => {
      setInterruptedNotice(data?.notice ?? null)
    }).catch(() => {})

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe()
    }
  }, [])

  const download = useCallback(async () => {
    const desktop = getBridge()
    setDownloadError(null)
    if (!desktop?.downloadUpdate) return
    try {
      const result = await desktop.downloadUpdate()
      if (result && result.ok === false) {
        setDownloadError(result.error || 'The download could not be started.')
      }
    } catch (err: any) {
      setDownloadError(err?.message || 'The download could not be started.')
    }
  }, [])

  const install = useCallback(async () => {
    const desktop = getBridge()
    setInstallError(null)
    if (!desktop?.installUpdate) return
    try {
      const result = await desktop.installUpdate()
      if (!result || result.ok) return
      if (result.needsChoice) {
        setChoice({
          message: result.message ?? 'Agent runs are still working.',
          total: result.activity?.agentRuns ?? 0,
        })
        return
      }
      const message = result.error ?? 'The update could not be applied.'
      setInstallError(message)
      setChoice({ message, total: 0 })
    } catch (err: any) {
      const message = err?.message || 'The update could not be applied.'
      setInstallError(message)
      setChoice({ message, total: 0 })
    }
  }, [])

  const restartNow = useCallback(() => {
    setChoice(null)
    setInstallError(null)
    void getBridge()?.installUpdate?.({ mode: 'now' })
  }, [])

  const restartWhenIdle = useCallback(async () => {
    setChoice(null)
    setInstallError(null)
    const result = await getBridge()?.installUpdate?.({ mode: 'when-idle' })
    if (result && result.ok === false) {
      const message = result.error ?? 'Could not start the restart.'
      setInstallError(message)
      setChoice({ message, total: 0 })
      return
    }
    setDraining(result?.activity?.agentRuns ?? 0)
  }, [])

  const cancelRestart = useCallback(async () => {
    setChoice(null)
    if (draining !== null) {
      setDraining(null)
      await getBridge()?.cancelIdleRestart?.()
    }
  }, [draining])

  // Persistent dismiss: tells the main process to stop re-broadcasting this
  // version for the rest of the session. Falls back to local hide if the
  // desktop bridge isn't available.
  const dismissAvailable = useCallback(() => {
    void getBridge()?.dismissUpdate?.()
    setDismissed(true)
  }, [])

  const dismissNotice = useCallback(() => {
    setInterruptedNotice(null)
    void getBridge()?.dismissInterruptedNotice?.()
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
    restartNow,
    restartWhenIdle,
    cancelRestart,
    dismissAvailable,
    choice,
    draining,
    interruptedNotice,
    dismissNotice,
    downloadError,
    installError,
  }
}
