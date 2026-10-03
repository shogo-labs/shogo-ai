// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop "local access" preferences: which local apps Shogo may read, whether
 * it may control the computer, and the dictation shortcuts.
 *
 * Keep the shape in sync with `packages/agent-runtime/src/local-access.ts`
 * (enforcement) and `apps/api/src/routes/local-access.ts` (storage).
 */
import type { DictationShortcutConfig, LocalAppId } from './desktop-bridge'

export type AppAccess = 'off' | 'read' | 'readwrite'

export interface LocalAccessPrefs {
  apps: Record<LocalAppId, AppAccess>
  computerUse: boolean
  blockedFolders: string[]
  dictation: DictationShortcutConfig
}

export const DEFAULT_PUSH_TO_TALK = 'Fn'

export function defaultLocalAccess(): LocalAccessPrefs {
  return {
    apps: { mail: 'read', messages: 'read', notes: 'read', whatsapp: 'read' },
    computerUse: false,
    blockedFolders: [],
    dictation: { pushToTalk: DEFAULT_PUSH_TO_TALK, handsFree: null },
  }
}

export const APP_ACCESS_LABELS: Record<AppAccess, string> = {
  off: 'Off',
  read: 'Read only',
  readwrite: 'Read and write',
}

export const APP_ACCESS_OPTIONS: AppAccess[] = ['read', 'readwrite', 'off']

export interface ShortcutOption {
  value: string | null
  label: string
}

export const PUSH_TO_TALK_OPTIONS: ShortcutOption[] = [
  { value: 'Fn', label: 'Fn' },
  { value: 'Control+Option+Space', label: '⌃⌥ Space' },
  { value: 'Option+Space', label: '⌥ Space' },
  { value: null, label: 'No shortcut' },
]

export const HANDS_FREE_OPTIONS: ShortcutOption[] = [
  { value: null, label: 'No shortcut' },
  { value: 'Control+Option+D', label: '⌃⌥ D' },
  { value: 'Option+Shift+Space', label: '⌥⇧ Space' },
  { value: 'Control+Shift+Space', label: '⌃⇧ Space' },
]

export function shortcutLabel(options: ShortcutOption[], value: string | null): string {
  return options.find((o) => o.value === value)?.label ?? value ?? 'No shortcut'
}
