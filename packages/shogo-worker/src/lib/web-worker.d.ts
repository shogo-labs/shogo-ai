// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The slice of the web Worker API the tunnel uses (SHO-185 §5).
 *
 * This package compiles against `lib: ["ES2022"]` — no DOM, no WebWorker — while
 * Bun supplies both globals at runtime. Declaring only what the tunnel touches
 * keeps the surface honest: a new worker global has to be added here, and the
 * tunnel keeps its real types instead of a cast at every use.
 */

declare const self: {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent) => void) | null
}

declare class Worker {
  constructor(url: URL)
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: unknown) => void) | null
  postMessage(message: unknown): void
  terminate(): void
}
