// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mock Stream Function for Pi Agent Core
 *
 * Creates a mock StreamFn that returns pre-configured responses in sequence.
 * Replaces the old MockAnthropic fetch interceptor.
 *
 * Re-exports the helpers from pi-adapter for backward compatibility in tests.
 */

export {
  createMockStreamFn,
  buildTextResponse,
  buildToolUseResponse,
} from '../../pi-adapter'
