// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Open in Shogo IDE" runs in the background: the IPC call returns at once
 * and progress arrives as `code-workbench:status` events, because a first
 * open downloads the server (minutes on a slow link). Electron-free.
 */

export type CodeWorkbenchPhase = 'downloading' | 'verifying' | 'extracting' | 'starting' | 'ready' | 'error'

export interface CodeWorkbenchStatus {
  projectId: string
  phase: CodeWorkbenchPhase
  received?: number
  total?: number
  message?: string
  logPath?: string
}

export type CodeWorkbenchReport = (
  phase: Exclude<CodeWorkbenchPhase, 'ready' | 'error'>,
  extra?: { received?: number; total?: number },
) => void

export type CodeWorkbenchOpenResult =
  | { ok: true; pending: true; alreadyPending?: true }
  | { ok: false; error: string }

export interface CodeWorkbenchOpenRequest {
  /** Opens with the same key share one run (owner window + project). */
  key: string
  projectId: string | undefined
  emit: (status: CodeWorkbenchStatus) => void
  run: (report: CodeWorkbenchReport) => Promise<void>
  onError?: (status: CodeWorkbenchStatus) => void
}

export function createCodeWorkbenchOpener(deps: { logPath: () => string; log?: (line: string) => void }) {
  const pending = new Set<string>()

  function open(request: CodeWorkbenchOpenRequest): CodeWorkbenchOpenResult {
    const { key, projectId, emit } = request
    if (!projectId) return { ok: false, error: 'project-id-required' }
    if (pending.has(key)) return { ok: true, pending: true, alreadyPending: true }
    pending.add(key)
    const report: CodeWorkbenchReport = (phase, extra) => emit({ projectId, phase, ...extra })
    void (async () => {
      try {
        await request.run(report)
        emit({ projectId, phase: 'ready' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        deps.log?.(`Open in Shogo IDE failed: ${message}`)
        const status: CodeWorkbenchStatus = { projectId, phase: 'error', message, logPath: deps.logPath() }
        emit(status)
        request.onError?.(status)
      } finally {
        pending.delete(key)
      }
    })()
    return { ok: true, pending: true }
  }

  return { open, isPending: (key: string) => pending.has(key) }
}
