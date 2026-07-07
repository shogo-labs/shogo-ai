// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Substrate abstraction barrel — the single import surface for "where does a
 * project run" lifecycle operations across metal and Knative. See ./types.ts.
 */

export type {
  ProjectSubstrate,
  SubstrateKind,
  RuntimeStatus,
  RuntimeSummary,
  ResolveOpts,
  WakeOpts,
  Resources,
} from './types'
export { SubstrateUnsupportedError } from './types'
export { MetalSubstrate, type MetalBackend } from './metal-substrate'
export { KnativeSubstrate, type KnativeBackend } from './knative-substrate'
export {
  getProjectSubstrate,
  destroyProjectRuntime,
  resizeProjectRuntime,
  type SubstrateRouterOpts,
} from './router'
