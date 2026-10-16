// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/** What crosses the boundary into the doc editor's DOM component; all JSON. */
import type { MentionMenuData } from '../../../lib/mention-menu'

/** `MentionMenuData` as JSON: member ids as a list, no clock. */
export type DocEditorData = Omit<MentionMenuData, 'memberIds' | 'now' | 'recent'> & { memberIds?: string[] | null }

export interface DocChipPress {
  token: string
  nodeKey: string
  /** Where the chip is, in the editor's viewport. */
  x: number
  y: number
  editable: boolean
}

export interface DocEditorHandle {
  /** Replace the content (e.g. someone else's save) without counting as an edit. */
  setMarkdown(markdown: string): void
  /** Insert a chip at the caret, e.g. a date from the picker. */
  insertToken(token: string): void
  /** Change a chip (e.g. an edited date), or remove it with null. */
  replaceToken(nodeKey: string, token: string | null): void
  focus(): void
  [key: string]: (...args: any[]) => void
}
