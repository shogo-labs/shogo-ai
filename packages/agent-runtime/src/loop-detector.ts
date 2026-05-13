// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Re-export shim. Canonical implementation lives in the MIT-licensed SDK
// at @shogo-ai/sdk/loop-detector. Keep this file as a thin re-export so
// downstream AGPL consumers don't need to be touched.
export { LoopDetector } from '@shogo-ai/sdk/loop-detector'
export type { LoopDetectorConfig, LoopDetectorResult } from '@shogo-ai/sdk/loop-detector'
