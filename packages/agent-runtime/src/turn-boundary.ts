// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Re-export shim. Canonical implementation lives in the MIT-licensed SDK
// at @shogo-ai/sdk/turn-boundary.
export {
  assistantWindowStart,
  compactToolArgs,
  compactionVariant,
  foldTurnMiddle,
  isFlattenedResult,
  lastTurnStart,
  messageChars,
  nthTurnStart,
  protectedStart,
  roundPlaceholder,
  summariseTurn,
  turnAwareCompactionEnabled,
  turnCount,
  turnInProgress,
} from '@shogo-ai/sdk/turn-boundary'
export type { FoldResult, TurnSummary } from '@shogo-ai/sdk/turn-boundary'
