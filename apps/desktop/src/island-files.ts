// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { readFile, stat } from 'fs/promises'
import { validateIslandFiles } from './island-attachments'
import type { IslandAttachment, IslandFileRef } from './island-protocol'

export type ReadIslandFilesResult =
  | { ok: true; attachments: IslandAttachment[] }
  | { ok: false; error: string }

export async function readIslandFiles(files: readonly IslandFileRef[]): Promise<ReadIslandFilesResult> {
  let sized: Array<IslandFileRef & { size: number }>
  try {
    sized = await Promise.all(
      files.map(async (file) => {
        const info = await stat(file.path)
        if (!info.isFile()) throw new Error(`"${file.name}" is not a file`)
        return { ...file, size: info.size }
      }),
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not read attachment' }
  }

  const invalid = validateIslandFiles(sized)
  if (invalid) return { ok: false, error: invalid }

  try {
    const attachments = await Promise.all(
      sized.map(async (file) => {
        const type = file.type || 'application/octet-stream'
        const data = await readFile(file.path)
        return { name: file.name, type, dataUrl: `data:${type};base64,${data.toString('base64')}` }
      }),
    )
    return { ok: true, attachments }
  } catch {
    return { ok: false, error: 'Could not read attachment' }
  }
}
