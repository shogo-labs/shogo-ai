// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Test helper for `read_lints`' language-server readiness poll.
 *
 * `read_lints` polls for a running `WorkspaceLSPManager` for up to
 * `SHOGO_READ_LINTS_WAIT_MS` (default 10s) before reporting that
 * type-checking is unavailable — the LSP warms up asynchronously in a real
 * pod, and failing fast made early calls report a phantom "not available".
 *
 * Tests that deliberately drive the no-LSP branch would otherwise sit
 * through the full 10s wait and blow past bun's 5s per-test timeout, so
 * they shrink the poll window to a few milliseconds.
 *
 *     beforeAll(() => shortenReadLintsWaitForTests())
 *     afterAll(() => restoreReadLintsWait())
 */

/** Long enough to run at least one poll iteration, short enough to be free. */
const TEST_WAIT_MS = '10'

let saved: string | undefined
let active = false

export function shortenReadLintsWaitForTests(): void {
  if (!active) {
    saved = process.env.SHOGO_READ_LINTS_WAIT_MS
    active = true
  }
  process.env.SHOGO_READ_LINTS_WAIT_MS = TEST_WAIT_MS
}

export function restoreReadLintsWait(): void {
  if (!active) return
  if (saved === undefined) delete process.env.SHOGO_READ_LINTS_WAIT_MS
  else process.env.SHOGO_READ_LINTS_WAIT_MS = saved
  active = false
}
