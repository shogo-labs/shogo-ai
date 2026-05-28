// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export {
  QuickFixEngine,
  tailLines,
} from './quick-fix-engine'
export type {
  QuickFixAction,
  QuickFixActionKind,
  QuickFixConfidence,
  QuickFixContext,
  QuickFixEngineOptions,
  QuickFixRule,
  QuickFixSuggestion,
} from './quick-fix-engine'

export {
  BUILT_IN_RULES,
  extractGitPathspec,
  extractMissingCommand,
  extractMissingModule,
  extractPort,
} from './quick-fix-rules'

export {
  QuickFixManager,
} from './quick-fix-manager'
export type {
  BufferReader,
  QuickFixClickEvent,
  QuickFixManagerOptions,
} from './quick-fix-manager'
