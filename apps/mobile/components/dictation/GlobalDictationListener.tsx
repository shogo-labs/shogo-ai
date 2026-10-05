// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop-only: reacts to the global dictation shortcuts (push to talk with
 * Fn or a chord, plus hands-free). The Electron main process emits
 * start/stop/cancel; this component captures the mic, transcribes the clip
 * through the local API and hands the text back so main can paste it into the
 * focused app.
 */
import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { getDesktopBridge } from '../../lib/desktop-bridge'
import {
  MicPermissionError,
  startDesktopDictation,
  transcribeDesktopClip,
  type DesktopDictation,
} from '../chat/desktop-dictation'

type Phase = 'idle' | 'listening' | 'transcribing' | 'error'

/** Pure session driver, exported for tests. */
export function createGlobalDictationSession(deps: {
  start: typeof startDesktopDictation
  transcribe: typeof transcribeDesktopClip
  deliver: (text: string) => Promise<unknown>
  onPhase: (phase: Phase, message?: string) => void
}) {
  let session: DesktopDictation | null = null
  let starting: Promise<void> | null = null
  // A stop/cancel can arrive while the mic is still opening.
  let queued: 'stop' | 'cancel' | null = null

  async function finish(kind: 'stop' | 'cancel') {
    const current = session
    session = null
    if (!current) return
    if (kind === 'cancel') {
      current.cancel()
      deps.onPhase('idle')
      return
    }
    deps.onPhase('transcribing')
    try {
      const wav = await current.stop()
      if (!wav) {
        deps.onPhase('idle')
        return
      }
      const text = (await deps.transcribe(wav)).trim()
      if (text) await deps.deliver(text)
      deps.onPhase('idle')
    } catch (err) {
      deps.onPhase('error', err instanceof Error ? err.message : 'Dictation failed')
    }
  }

  return {
    async start() {
      if (session || starting) return
      queued = null
      deps.onPhase('listening')
      starting = deps
        .start()
        .then((s) => {
          session = s
        })
        .catch((err) => {
          deps.onPhase(
            'error',
            err instanceof MicPermissionError
              ? 'Microphone access is blocked. Allow it in Settings > Computer and files.'
              : err instanceof Error
                ? err.message
                : 'Could not start dictation',
          )
        })
        .finally(() => {
          starting = null
        })
      await starting
      if (queued && session) {
        const pending = queued
        queued = null
        await finish(pending)
      }
    },
    async stop() {
      if (starting) {
        queued = 'stop'
        return
      }
      await finish('stop')
    },
    async cancel() {
      if (starting) {
        queued = 'cancel'
        return
      }
      await finish('cancel')
    },
  }
}

export function GlobalDictationListener() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | undefined>()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const dictation = getDesktopBridge()?.dictation
    if (!dictation) return

    const driver = createGlobalDictationSession({
      start: startDesktopDictation,
      transcribe: transcribeDesktopClip,
      deliver: (text) => dictation.deliverText(text),
      onPhase: (next, msg) => {
        setPhase(next)
        setMessage(msg)
        if (timer.current) clearTimeout(timer.current)
        if (next === 'error') {
          timer.current = setTimeout(() => setPhase('idle'), 4000)
        }
      },
    })

    const off = dictation.onEvent((event) => {
      if (event.type === 'start') void driver.start()
      else if (event.type === 'stop') void driver.stop()
      else void driver.cancel()
    })
    return () => {
      off()
      void driver.cancel()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  if (phase === 'idle') return null
  const label =
    phase === 'listening' ? 'Listening…' : phase === 'transcribing' ? 'Transcribing…' : (message ?? 'Dictation failed')

  return (
    <View pointerEvents="none" className="absolute inset-x-0 bottom-8 z-50 items-center" testID="global-dictation-pill">
      <View className="rounded-full border border-border bg-popover px-4 py-2 shadow-lg">
        <Text className={phase === 'error' ? 'text-sm text-destructive' : 'text-sm font-medium text-foreground'}>
          {label}
        </Text>
      </View>
    </View>
  )
}

export default GlobalDictationListener
