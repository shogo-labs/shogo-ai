// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { FinishReason } from 'ai'

/**
 * AI SDK UI message chunks do not have an "abort" finishReason. The separate
 * data-turn-complete frame carries the user-aborted state, so use the SDK's
 * catch-all reason for the terminal finish chunk.
 */
export function getStreamFinishReason(wasAborted: boolean): FinishReason {
  return wasAborted ? 'other' : 'stop'
}
