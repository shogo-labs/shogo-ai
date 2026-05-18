// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-export shim. The implementation now lives in
 * `@shogo-ai/sdk/tech-stack-registry` (canonical:
 * `@shogo-ai/core/tech-stack-registry`) under MIT, lifted from this file
 * as part of the MIT carve-out of `@shogo/shared-runtime`. Existing AGPL
 * consumers that import from `@shogo/shared-runtime` continue to work
 * unchanged.
 *
 * New code should prefer the canonical SDK import:
 *   import { TECH_STACK_REGISTRY } from '@shogo-ai/sdk/tech-stack-registry'
 */

export {
  TECH_STACK_REGISTRY,
  getStackEntry,
  isMobileTechStack,
  usesMetroBundler,
  stackSeedsItself,
  type StackTarget,
  type StackRegistryEntry,
} from '@shogo-ai/sdk/tech-stack-registry'
