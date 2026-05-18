// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-export shim. The implementation now lives in
 * `@shogo-ai/sdk/instrumentation` under MIT, lifted from this file as
 * part of Wave 1 of the SDK dogfood roadmap. Existing consumers that
 * import from `@shogo/shared-runtime` continue to work unchanged.
 *
 * New code should prefer the canonical SDK import:
 *   import { initInstrumentation } from '@shogo-ai/sdk/instrumentation'
 */

export {
  initInstrumentation,
  shutdownInstrumentation,
  traceOperation,
  type InstrumentationConfig,
} from '@shogo-ai/sdk/instrumentation'
