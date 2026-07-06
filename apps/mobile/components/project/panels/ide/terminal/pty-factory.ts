// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Transport-agnostic factory for the IDE terminal's PtyClient.
 *
 * Two transports plug in behind one interface:
 *   - WS-backed `PtyClient`   (mobile, web, runtime pod) — default.
 *   - IPC-backed Desktop client (Electron renderer)      — opt-in when
 *     `window.shogoDesktopTerminal` is present, unless the URL carries
 *     `?ws=force` (an A/B debug switch).
 *
 * The desktop client lives in `@shogo/desktop-terminal` and is loaded
 * via dynamic `import()` so mobile/web bundles include only a chunk
 * shim — they never fetch it because `isDesktopRuntime()` returns false.
 *
 * `createPtyClient` is now async (was sync). Terminal.tsx awaits it
 * once per session — provisionSession() was already async. That is the
 * ONLY consumer change in the React tree.
 */

import { PtyClient } from './pty-client'
import { loadDesktopTerminal } from './desktop-terminal-loader'

export type PtyClientStateLike =
  | 'idle' | 'connecting' | 'open' | 'closed' | 'disposed'

export interface PtyClientLike {
  readonly state: PtyClientStateLike
  connect(): void
  send(bytes: string | Uint8Array): void
  resize(cols: number, rows: number): void
  signal(sig: 'INT' | 'TERM' | 'KILL'): void
  dispose(): void
  onState(cb: (s: PtyClientStateLike) => void): () => void
  onData(cb: (b: Uint8Array) => void): () => void
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): () => void
  onError(cb: (err: Error) => void): () => void
  onTruncated(cb: () => void): () => void
}

export interface PtyClientSessionInfo {
  id: string
  cwd: string
  cols: number
  rows: number
  createdAt: number
}

export interface PtyClientProvisionResult {
  client: PtyClientLike
  session: PtyClientSessionInfo
}

/**
 * Arguments accepted by `createPtyClient`. Backwards-compatible: a bare
 * URL string is still accepted and is identical to `{ url }`.
 */
export type CreatePtyClientArgs =
  | string
  | {
      /** WS URL — required for the legacy / mobile / web path. */
      url?: string
      /**
       * Logical session id (matches both the WS path's URL segment and
       * the desktop session id). Required for desktop transport.
       */
      sessionId?: string
      /**
       * Force the WS path even if running in Electron. Useful for A/B
       * testing during development. Default: false.
       */
      forceWs?: boolean
      /**
       * Desktop-only provisioning. When present in Electron, the factory
       * calls shogoDesktopTerminal.spawn() first, then attaches via MessagePort.
       */
      spawn?: {
        projectId?: string
        cwd?: string
        shell?: string
        args?: string[]
        env?: Record<string, string>
        cols: number
        rows: number
        restoreId?: string
      }
    }

export function isDesktopRuntime(): boolean {
  const g = globalThis as { shogoDesktopTerminal?: unknown }
  return typeof g !== 'undefined' && typeof g.shogoDesktopTerminal !== 'undefined' && g.shogoDesktopTerminal !== null
}

// Eager warmup of the desktop module: kick off the import the first time
// pty-factory.ts is loaded in an Electron renderer. By the time the user
// clicks the terminal panel (which takes hundreds of ms minimum: REST
// POST + estimateGridSize + xterm lazy-load), the import has resolved.
//
// Browsers / RN never enter this branch because `window.shogoDesktopTerminal`
// is undefined — the dynamic import is a separate chunk that's emitted but
// never fetched.
type DesktopFactory = {
  attach(sessionId: string): PtyClientLike
  spawn(opts: NonNullable<Extract<CreatePtyClientArgs, object>['spawn']>): Promise<{
    client: PtyClientLike
    session: {
      id: string
      cwd: string
      cols: number
      rows: number
      createdAt: number
    }
  }>
}

let desktopFactoryPromise: Promise<DesktopFactory> | null = null

function loadDesktopFactory(): Promise<DesktopFactory> {
  if (!desktopFactoryPromise) {
    desktopFactoryPromise = loadDesktopTerminal().then((m) => ({
      attach: (sessionId: string) => m.createDesktopPtyClient(sessionId) as unknown as PtyClientLike,
      spawn: async (opts) => {
        const { client, session } = await m.spawnDesktopPtyClient(opts)
        return { client: client as unknown as PtyClientLike, session }
      },
    }))
  }
  return desktopFactoryPromise
}

if (isDesktopRuntime()) {
  // Warm the chunk; ignore errors here (the factory call below will
  // surface them through emitError of the consumer).
  void loadDesktopFactory().catch(() => undefined)
}

/**
 * Resolve which transport this session should use. Exported for tests.
 */
export function chooseTransport(args: CreatePtyClientArgs): 'desktop' | 'ws' {
  const a = typeof args === 'string' ? { url: args } : args
  if (a.forceWs) return 'ws'
  if (isDesktopRuntime() && (a.sessionId || a.spawn)) return 'desktop'
  // URL with ?ws=force respects the debug switch even if the caller
  // didn't set forceWs in args.
  if (a.url && /[?&]ws=force(?:&|$)/.test(a.url)) return 'ws'
  return 'ws'
}

export async function createPtyClient(args: CreatePtyClientArgs): Promise<PtyClientLike> {
  const a = typeof args === 'string' ? { url: args } : args
  const transport = chooseTransport(a)

  if (transport === 'desktop') {
    const factory = await loadDesktopFactory()
    if (a.spawn) {
      const { client } = await factory.spawn(a.spawn)
      return client
    }
    if (!a.sessionId) throw new Error('createPtyClient: sessionId or spawn is required for desktop transport')
    return factory.attach(a.sessionId)
  }

  if (!a.url) throw new Error('createPtyClient: url is required for WebSocket transport')
  return new PtyClient({ url: a.url })
}

export async function createPtyClientSession(
  args: Extract<CreatePtyClientArgs, object> & { spawn: NonNullable<Extract<CreatePtyClientArgs, object>['spawn']> },
): Promise<PtyClientProvisionResult> {
  if (!isDesktopRuntime()) {
    throw new Error('createPtyClientSession: desktop runtime is required')
  }
  const factory = await loadDesktopFactory()
  return factory.spawn(args.spawn)
}
