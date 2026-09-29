// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export const ISLAND_MAX_FILES = 10
export const ISLAND_MAX_FILE_SIZE = 10 * 1024 * 1024

export interface IslandAttachment {
  dataUrl: string
  name: string
  type: string
}

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

export function validateIslandFiles(
  files: readonly Pick<File, 'name' | 'size' | 'type'>[],
): string | null {
  if (files.length > ISLAND_MAX_FILES) {
    return `Maximum ${ISLAND_MAX_FILES} files allowed`
  }
  const oversized = files.find(
    (file) =>
      !isIslandArchive(file.name, file.type) &&
      file.size > ISLAND_MAX_FILE_SIZE,
  )
  if (oversized) {
    return `File "${oversized.name}" exceeds ${ISLAND_MAX_FILE_SIZE / (1024 * 1024)}MB limit`
  }
  return null
}
