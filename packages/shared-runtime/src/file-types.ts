// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-export shim. The implementation lives in
 * `@shogo-ai/core/file-types` (canonical, MIT). Existing AGPL consumers
 * that import from `@shogo/shared-runtime` continue to work unchanged.
 *
 * New code should prefer the canonical import:
 *   import { isBinaryFilePath } from '@shogo-ai/core/file-types'
 */

export {
  BINARY_FILE_EXTENSIONS,
  isBinaryFilePath,
} from '@shogo-ai/sdk/file-types'
