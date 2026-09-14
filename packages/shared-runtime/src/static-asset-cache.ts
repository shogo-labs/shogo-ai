// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Cache policy shared by preview and publish servers. Only filenames with a
 * content hash can safely be immutable because user projects commonly keep
 * the same name for favicons and files under public/.
 */
export function isContentHashedFilename(fileName: string): boolean {
  const base = fileName.split('/').pop() || fileName
  return /[-_][A-Za-z0-9]{8,}\.[A-Za-z0-9]+$/.test(base)
}

export function staticAssetCacheControl(fileName: string): string {
  return isContentHashedFilename(fileName)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
}
