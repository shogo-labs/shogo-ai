// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-export shim. The implementation now lives in
 * `@shogo-ai/sdk/ai-proxy` (canonical: `@shogo-ai/agent/ai-proxy`) under
 * MIT, lifted from this file as part of the MIT carve-out of
 * `@shogo/shared-runtime`. Existing AGPL consumers that import from
 * `@shogo/shared-runtime` continue to work unchanged.
 *
 * New code should prefer the canonical SDK import:
 *   import { configureAIProxy } from '@shogo-ai/sdk/ai-proxy'
 */

export { configureAIProxy, type AIProxyConfig } from '@shogo-ai/sdk/ai-proxy'
