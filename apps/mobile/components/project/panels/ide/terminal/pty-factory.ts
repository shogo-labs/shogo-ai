// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One-line factory that wraps `new PtyClient({ url })`.
 *
 * Lives in its own file so `Terminal.tsx`'s consumers can swap PTY-client
 * construction in tests via `mock.module('.../pty-factory', ...)`. We can't
 * mock `pty-client` directly because Bun's `mock.module` is process-wide,
 * which would leak into the dedicated `pty-client` unit tests.
 *
 * Production code never imports `PtyClient` from `Terminal.tsx` — always
 * goes through this factory.
 */

import { PtyClient } from './pty-client'

export interface PtyClientLike {
  readonly state: 'idle' | 'connecting' | 'open' | 'closed' | 'disposed'
  connect(): void
  send(bytes: string | Uint8Array): void
  resize(cols: number, rows: number): void
  signal(sig: 'INT' | 'TERM' | 'KILL'): void
  dispose(): void
  onState(cb: (s: 'idle' | 'connecting' | 'open' | 'closed' | 'disposed') => void): () => void
  onData(cb: (b: Uint8Array) => void): () => void
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): () => void
  onError(cb: (err: Error) => void): () => void
  onTruncated(cb: () => void): () => void
}

export function createPtyClient(url: string): PtyClientLike {
  return new PtyClient({ url })
}
