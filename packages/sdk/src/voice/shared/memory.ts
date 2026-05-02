// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Platform-agnostic memory plumbing for the voice hooks:
 *
 *   - `createMemoryAddTool` builds the canonical `add_memory` client
 *     tool that POSTs to `memoryAddPath`. Mounted on the convai
 *     session's `clientTools` map so the agent can persist user-stated
 *     facts via a tool call.
 *   - `createMemoryContextInjector` returns an `inject(userText)`
 *     function that fetches `limit` relevant memory chunks from
 *     `memoryRetrievePath` and forwards them to the active session as
 *     a contextual update — but only if the chunks differ from the
 *     last batch we sent (so we don't re-inject the same context every
 *     turn).
 *
 * Both factories take only the bits they need (a `PostJson`, a couple
 * of refs) so the same code runs on web and native without DOM hooks.
 */

import type { MutableRefObject } from 'react'
import type { PostJson } from './postJson.js'

export type ClientToolFn = (
  params: Record<string, unknown>,
) => Promise<string> | string

export interface CreateMemoryAddToolOptions {
  postJson: PostJson
  memoryAddPath: string
}

/**
 * Returns the `add_memory` client tool. The tool reads `params.fact`
 * (a free-form string) and POSTs it to the consumer's `/api/memory/add`
 * endpoint. Errors and empty facts return human-readable failure
 * strings so the agent's transcript stays meaningful.
 */
export function createMemoryAddTool({
  postJson,
  memoryAddPath,
}: CreateMemoryAddToolOptions): ClientToolFn {
  return async (params: Record<string, unknown>) => {
    const fact = typeof params.fact === 'string' ? params.fact : ''
    if (!fact.trim()) return 'Memory save failed: empty fact.'
    try {
      const res = await postJson(memoryAddPath, { fact })
      if (!res.ok) return 'Failed to save memory.'
      return 'Memory saved.'
    } catch {
      return 'Memory save failed.'
    }
  }
}

export interface CreateMemoryContextInjectorOptions {
  postJson: PostJson
  memoryRetrievePath: string
  /**
   * Mirror of the active convai session. We only need
   * `sendContextualUpdate`; passing the whole convo lets the caller
   * keep its existing ref instead of forcing it to forward a single
   * method.
   */
  conversationRef: MutableRefObject<{
    sendContextualUpdate: (text: string) => void
  } | null>
  /** When false, the injector becomes a no-op. */
  enabled: boolean
  /**
   * Tracks the last successfully injected lines block so we don't
   * re-inject identical context. Owned by the caller and reset to ''
   * on connect.
   */
  lastInjectedRef: MutableRefObject<string>
}

export type MemoryContextInjector = (userText: string) => Promise<void>

export function createMemoryContextInjector({
  postJson,
  memoryRetrievePath,
  conversationRef,
  enabled,
  lastInjectedRef,
}: CreateMemoryContextInjectorOptions): MemoryContextInjector {
  return async function inject(userText: string): Promise<void> {
    if (!enabled) return
    try {
      const res = await postJson(memoryRetrievePath, { query: userText, limit: 4 })
      if (!res.ok) return
      const data = (await res.json()) as {
        results?: Array<{ chunk: string; score?: number }>
        took_ms?: number
      }
      const results = data.results ?? []
      if (!results.length) return
      const lines = results
        .map((r) => `- ${r.chunk.trim().replace(/\s+/g, ' ').slice(0, 200)}`)
        .join('\n')
      if (lines === lastInjectedRef.current) return
      lastInjectedRef.current = lines
      const payload = `Relevant memory about this user:\n${lines}`
      conversationRef.current?.sendContextualUpdate(payload)
    } catch {
      // Memory injection is best-effort; swallow errors.
    }
  }
}
