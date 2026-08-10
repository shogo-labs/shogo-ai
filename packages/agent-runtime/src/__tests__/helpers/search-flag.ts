// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Test helper for the `search` tool feature flag.
 *
 * `createTools()` only registers the semantic `search` tool when
 * `SHOGO_SEARCH_ENABLED=1` (see `src/search-flag.ts`). Production pods
 * deliberately leave the flag unset, so any test that exercises the tool
 * itself has to opt in — otherwise `tools.find(t => t.name === 'search')`
 * comes back undefined.
 *
 * The prod-side contract (flag unset ⇒ tool absent ⇒ prompts must not
 * advertise it) is covered by `search-advertisement-contract.test.ts`.
 *
 *     beforeAll(() => enableSearchToolForTests())
 *     afterAll(() => restoreSearchToolFlag())
 */

let saved: string | undefined
let active = false

export function enableSearchToolForTests(): void {
  if (!active) {
    saved = process.env.SHOGO_SEARCH_ENABLED
    active = true
  }
  process.env.SHOGO_SEARCH_ENABLED = '1'
}

export function restoreSearchToolFlag(): void {
  if (!active) return
  if (saved === undefined) delete process.env.SHOGO_SEARCH_ENABLED
  else process.env.SHOGO_SEARCH_ENABLED = saved
  active = false
}
