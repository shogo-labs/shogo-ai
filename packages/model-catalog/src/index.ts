// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-export shim. The implementation now lives in
 * `@shogo-ai/sdk/model-catalog` under MIT, lifted from this package as
 * part of Wave 1 of the SDK dogfood roadmap. Existing consumers that
 * import from `@shogo/model-catalog` continue to work unchanged.
 *
 * New code should prefer the canonical SDK import:
 *   import { MODEL_CATALOG, getModelEntry } from '@shogo-ai/sdk/model-catalog'
 *
 * The internal `models.ts`, `aliases.ts`, and `helpers.ts` files were
 * removed when the lift landed — anything that was reaching into them
 * directly should switch to the public surface above.
 */

export * from '@shogo-ai/sdk/model-catalog'
