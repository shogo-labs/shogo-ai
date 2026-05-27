// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Re-export shim. The implementation lives in `@shogo-ai/core/file-types`
 * — this subpath exists so SDK consumers (mobile, agent-runtime, …) can
 * pull the canonical binary-extension predicate without taking on a
 * direct `@shogo-ai/core` dependency.
 *
 * Prefer the canonical import in new code:
 *   import { isBinaryFilePath } from '@shogo-ai/core/file-types'
 */
export * from '@shogo-ai/core/file-types'
