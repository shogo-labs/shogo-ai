// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime Manager Module
 *
 * Exports RuntimeManager for managing Vite dev server processes per project.
 */

export {
  RuntimeManager,
  createRuntimeManager,
  getRuntimeManager,
  setRuntimeManager,
  __resetRuntimeManagerInternalsForTests,
  resolveRuntimeMaxCount,
  resolveWorkspaceBackgroundMax,
} from './manager'
export {
  PREVIEW_MAX_BY_TIER,
  DEFAULT_PREVIEW_MAX,
  resolveWorkspacePreviewCap,
  resolveWorkspacePreviewMax,
} from './preview-cap'
export type { HostTier, PreviewCapDecision } from './preview-cap'
export type {
  IRuntimeManager,
  IProjectRuntime,
  IRuntimeConfig,
  IHealthStatus,
  RuntimeStatus,
} from './types'
