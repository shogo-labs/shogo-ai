// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { randomUUID } from 'crypto'
import { PtySession } from './pty-session'
import type { PtyShell } from './pty-protocol'

const DEFAULT_IDLE_TTL_MS = 10 * 60_000
const DEFAULT_MAX_AGE_MS = 8 * 60 * 60_000
const DEFAULT_MAX_SESSIONS = 8

export interface PtyRegistryOptions {
  rootDir: string
  idleTtlMs?: number
  maxAgeMs?: number
  maxSessions?: number
}

export interface GetOrCreateArgs {
  sessionId?: string
  cwd?: string
  cols: number
  rows: number
  shell?: PtyShell
}

export class PtyRegistry {
  private readonly sessions = new Map<string, PtySession>()
  private readonly rootDir: string
  private readonly idleTtlMs: number
  private readonly maxAgeMs: number
  private readonly maxSessions: number

  constructor(options: PtyRegistryOptions) {
    this.rootDir = options.rootDir
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  }

  async getOrCreate(args: GetOrCreateArgs): Promise<{
    session: PtySession
    attached: boolean
    created: boolean
    scrollback: string
  }> {
    this.reapExpired()
    if (args.sessionId) {
      const existing = this.sessions.get(args.sessionId)
      if (existing) {
        const attach = existing.attach()
        if (!attach.ok) throw new Error(attach.reason === 'attached' ? 'session_attached_elsewhere' : 'session_exited')
        existing.resize(args.cols, args.rows)
        return { session: existing, attached: true, created: false, scrollback: attach.scrollback }
      }
    }
    if (this.sessions.size >= this.maxSessions) {
      this.reapOldestDetached()
      if (this.sessions.size >= this.maxSessions) throw new Error('too_many_pty_sessions')
    }
    const id = args.sessionId || randomUUID()
    const session = await PtySession.create({
      id,
      cwd: args.cwd || this.rootDir,
      rootDir: this.rootDir,
      cols: args.cols,
      rows: args.rows,
      shell: args.shell,
    })
    const attach = session.attach()
    if (!attach.ok) throw new Error('session_attach_failed')
    session.onExit(() => {
      if (this.sessions.get(id) !== session) return
      setTimeout(() => {
        if (!session.isAttached()) this.sessions.delete(id)
      }, 30_000).unref?.()
    })
    this.sessions.set(id, session)
    return { session, attached: false, created: true, scrollback: attach.scrollback }
  }

  detach(sessionId: string): void {
    this.sessions.get(sessionId)?.detach()
  }

  kill(sessionId: string, signal: NodeJS.Signals = 'SIGTERM'): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.kill(signal)
    if (signal === 'SIGTERM') {
      setTimeout(() => {
        if (!session.isExited()) session.kill('SIGKILL')
      }, 2_000).unref?.()
    }
    this.sessions.delete(sessionId)
  }

  reapExpired(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      const tooOld = now - session.createdAt > this.maxAgeMs
      const idle = now - session.lastActivityAt > this.idleTtlMs
      if (tooOld || (idle && !session.isAttached()) || session.isExited()) {
        if (!session.isExited()) session.kill('SIGTERM')
        this.sessions.delete(id)
      }
    }
  }

  size(): number {
    return this.sessions.size
  }

  private reapOldestDetached(): void {
    let oldest: { id: string; lastActivityAt: number } | null = null
    for (const [id, session] of this.sessions) {
      if (session.isAttached()) continue
      if (!oldest || session.lastActivityAt < oldest.lastActivityAt) {
        oldest = { id, lastActivityAt: session.lastActivityAt }
      }
    }
    if (oldest) this.kill(oldest.id)
  }
}
