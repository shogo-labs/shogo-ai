// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hooks for the Run-and-Debug panel.
 *
 *   useRunScripts(root)   — fetches package.json scripts + detected pm
 *   useRunSession(root, script, pm)
 *                         — owns a single live script execution. Calls
 *                           shogoDesktop.run.start, subscribes to
 *                           output + exit events, exposes start/stop/clear.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

type Pm = 'bun' | 'pnpm' | 'yarn' | 'npm'

interface ScriptEntry {
  name: string
  command: string
}

interface RunBridge {
  listScripts(root: string): Promise<{ ok: boolean; scripts?: ScriptEntry[]; packageManager?: Pm; error?: string }>
  start(root: string, script: string, pm?: Pm): Promise<{ ok: boolean; runId?: string; error?: string }>
  stop(runId: string): Promise<{ ok: boolean; error?: string }>
  onOutput(runId: string, cb: (d: { stream: 'stdout' | 'stderr'; data: string }) => void): () => void
  onExit(runId: string, cb: (info: { code: number | null; signal: string | null }) => void): () => void
}

function getBridge(): RunBridge | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { shogoDesktop?: { run?: RunBridge } }
  return w.shogoDesktop?.run ?? null
}

export function useRunScripts(workspaceRoot: string) {
  const [scripts, setScripts] = useState<ScriptEntry[]>([])
  const [packageManager, setPackageManager] = useState<Pm | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const bridge = getBridge()
    if (!bridge) {
      setError('Run-and-Debug requires the Shogo desktop app.')
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const res = await bridge.listScripts(workspaceRoot)
    if (!res.ok) {
      setError(res.error ?? 'failed to read package.json')
      setScripts([])
      setPackageManager(null)
    } else {
      setScripts(res.scripts ?? [])
      setPackageManager(res.packageManager ?? null)
    }
    setLoading(false)
  }, [workspaceRoot])

  useEffect(() => { void refresh() }, [refresh])

  return { scripts, packageManager, loading, error, refresh }
}

type SessionStatus = 'idle' | 'starting' | 'running' | 'exit-ok' | 'exit-err' | 'failed'

export function useRunSession(workspaceRoot: string, _selected: string | null, pm: Pm | null) {
  const [runId, setRunId] = useState<string | null>(null)
  const [script, setScript] = useState<string | null>(null)
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [output, setOutput] = useState<Array<{ stream: 'stdout' | 'stderr'; data: string }>>([])
  const unsubsRef = useRef<Array<() => void>>([])

  // Cleanup on unmount or when runId changes
  useEffect(() => {
    return () => {
      for (const u of unsubsRef.current) u()
      unsubsRef.current = []
    }
  }, [])

  const start = useCallback(
    async (scriptName: string) => {
      const bridge = getBridge()
      if (!bridge) return
      // Tear down any previous run before starting a new one
      if (runId) {
        await bridge.stop(runId).catch(() => undefined)
      }
      for (const u of unsubsRef.current) u()
      unsubsRef.current = []

      setScript(scriptName)
      setStatus('starting')
      setOutput([])
      setExitCode(null)

      const res = await bridge.start(workspaceRoot, scriptName, pm ?? undefined)
      if (!res.ok || !res.runId) {
        setStatus('failed')
        setOutput([{ stream: 'stderr', data: `[shogo] ${res.error ?? 'start failed'}\n` }])
        setRunId(null)
        return
      }
      setRunId(res.runId)
      setStatus('running')

      // Subscribe to streams. Bridge returns disposers; collect them.
      const offOutput = bridge.onOutput(res.runId, (chunk) => {
        setOutput((prev) => {
          // Coalesce small consecutive same-stream chunks to keep DOM tame
          if (prev.length > 0 && prev[prev.length - 1].stream === chunk.stream && prev[prev.length - 1].data.length < 4000) {
            const next = prev.slice(0, -1)
            next.push({ stream: chunk.stream, data: prev[prev.length - 1].data + chunk.data })
            return next
          }
          return [...prev, chunk]
        })
      })
      const offExit = bridge.onExit(res.runId, (info) => {
        setExitCode(info.code)
        setStatus(info.code === 0 ? 'exit-ok' : 'exit-err')
        // Don't clear runId here — keeps the UI showing "done" until
        // the user starts another run.
      })
      unsubsRef.current = [offOutput, offExit]
    },
    [workspaceRoot, runId, pm],
  )

  const stop = useCallback(async () => {
    const bridge = getBridge()
    if (!bridge || !runId) return
    await bridge.stop(runId)
    // Exit handler will flip status to exit-ok / exit-err.
  }, [runId])

  const clear = useCallback(() => {
    setOutput([])
  }, [])

  return { runId, script, status, exitCode, output, start, stop, clear }
}
