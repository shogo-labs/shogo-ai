// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-export shim. The implementation now lives in
 * `@shogo-ai/sdk/stream-buffer` under MIT, lifted from this file as
 * part of Wave 1 of the SDK dogfood roadmap. Existing consumers that
 * import from `@shogo/shared-runtime` continue to work unchanged.
 *
 * New code should prefer the canonical SDK import:
 *   import { StreamBufferStore } from '@shogo-ai/sdk/stream-buffer'
 */

export {
  StreamBufferStore,
  createBufferingTransform,
  type StreamBufferWriter,
  type TurnStatus,
  type TurnTerminal,
  type TurnSnapshot,
  type ReplayOptions,
} from '@shogo-ai/sdk/stream-buffer'
