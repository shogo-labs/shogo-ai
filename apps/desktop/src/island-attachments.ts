// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export const ISLAND_MAX_FILES = 10
/**
 * The island is local mode, which resolves to a paid plan — so files and
 * archives share the 500 MB paid ceiling (SHO-370). There is no separate
 * archive limit any more.
 */
export const ISLAND_MAX_FILE_SIZE = 500 * 1024 * 1024
export const ISLAND_MAX_ARCHIVE_SIZE = ISLAND_MAX_FILE_SIZE

export function isIslandArchive(name: string, type = ''): boolean {
  const lowerName = name.toLowerCase()
  const lowerType = type.toLowerCase()
  return (
    lowerName.endsWith('.zip') ||
    lowerName.endsWith('.shogo') ||
    lowerName.endsWith('.shogo-project') ||
    lowerType === 'application/zip' ||
    lowerType === 'application/x-zip-compressed'
  )
}

function formatMb(bytes: number): string {
  return `${bytes / (1024 * 1024)}MB`
}

export function validateIslandFiles(
  files: readonly { name: string; size: number; type: string }[],
): string | null {
  if (files.length > ISLAND_MAX_FILES) {
    return `Maximum ${ISLAND_MAX_FILES} files allowed`
  }
  for (const file of files) {
    const limit = isIslandArchive(file.name, file.type) ? ISLAND_MAX_ARCHIVE_SIZE : ISLAND_MAX_FILE_SIZE
    if (file.size > limit) {
      return `File "${file.name}" exceeds ${formatMb(limit)} limit`
    }
  }
  return null
}
