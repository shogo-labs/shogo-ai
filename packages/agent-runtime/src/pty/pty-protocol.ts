// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export type PtySignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'EOF'

export type PtyShell = 'bash' | 'zsh' | 'sh' | 'pwsh' | 'powershell' | 'cmd'

export type PtyClientFrame =
  | { type: 'init'; sessionId?: string; cols: number; rows: number; cwd?: string; shell?: PtyShell }
  | { type: 'data'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'signal'; signal: PtySignal }
  | { type: 'ping' }

export type PtyServerFrame =
  | { type: 'ready'; sessionId: string; cwd: string; scrollback?: string; attached: boolean }
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number | null; signal: string | null }
  | { type: 'error'; message: string }
  | { type: 'pong' }

export function serializePtyFrame(frame: PtyClientFrame | PtyServerFrame): string {
  return JSON.stringify(frame)
}

export function parsePtyClientFrame(raw: string | Buffer | ArrayBuffer | Uint8Array): PtyClientFrame {
  const text =
    typeof raw === 'string'
      ? raw
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(raw)).toString('utf8')
          : Buffer.from(raw).toString('utf8')
  const value = JSON.parse(text) as unknown
  if (!value || typeof value !== 'object') {
    throw new Error('PTY frame must be an object')
  }
  const frame = value as Record<string, unknown>
  switch (frame.type) {
    case 'init': {
      const cols = clampDimension(frame.cols, 2, 500, 80)
      const rows = clampDimension(frame.rows, 2, 200, 24)
      return {
        type: 'init',
        sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : undefined,
        cols,
        rows,
        cwd: typeof frame.cwd === 'string' ? frame.cwd : undefined,
        shell: isShell(frame.shell) ? frame.shell : undefined,
      }
    }
    case 'data':
      if (typeof frame.data !== 'string') throw new Error('PTY data frame requires string data')
      if (frame.data.length > 64 * 1024) throw new Error('PTY data frame too large')
      return { type: 'data', data: frame.data }
    case 'resize':
      return {
        type: 'resize',
        cols: clampDimension(frame.cols, 2, 500, 80),
        rows: clampDimension(frame.rows, 2, 200, 24),
      }
    case 'signal':
      if (!isSignal(frame.signal)) throw new Error('Unsupported PTY signal')
      return { type: 'signal', signal: frame.signal }
    case 'ping':
      return { type: 'ping' }
    default:
      throw new Error('Unknown PTY frame type')
  }
}

function clampDimension(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

function isShell(value: unknown): value is PtyShell {
  return value === 'bash' || value === 'zsh' || value === 'sh' || value === 'pwsh' || value === 'powershell' || value === 'cmd'
}

function isSignal(value: unknown): value is PtySignal {
  return value === 'SIGINT' || value === 'SIGTERM' || value === 'SIGKILL' || value === 'EOF'
}
