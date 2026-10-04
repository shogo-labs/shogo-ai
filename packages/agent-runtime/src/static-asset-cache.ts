// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { existsSync, statSync } from 'fs'
import { join } from 'path'

export {
  isContentHashedFilename,
  staticAssetCacheControl,
  shouldServeSpaFallback,
} from '@shogo/shared-runtime'

/**
 * The file a dist path maps to: the path itself, its directory index
 * (`about/` → `about/index.html`), or `about.html`. Multi-page builds
 * (Astro, Eleventy) emit pages in those shapes; without this every inner
 * page would fall through to the SPA fallback and render the homepage.
 */
export function resolveDistFile(filePath: string): string | null {
  for (const candidate of [filePath, join(filePath, 'index.html'), `${filePath.replace(/\/+$/, '')}.html`]) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}
