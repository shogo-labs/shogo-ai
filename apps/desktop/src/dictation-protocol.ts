// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Dictation shortcut configuration shared by the config file, the hotkey
 * service and the renderer bridge. Pure, so it can be unit tested without Electron.
 */

export interface DictationConfig {
  /** `Fn`, or an Electron accelerator for a hold-to-talk combo. `null` disables it. */
  pushToTalk: string | null
  /** Electron accelerator that toggles dictation on and off. `null` disables it. */
  handsFree: string | null
}

export const FN_KEY = 'Fn'

export const DEFAULT_DICTATION_CONFIG: DictationConfig = {
  pushToTalk: FN_KEY,
  handsFree: null,
}

const MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'option', 'alt', 'shift', 'super', 'meta',
])

/**
 * Conservative accelerator check: `Mod+Mod+Key`, at least one modifier and
 * exactly one non-modifier key (letters, digits, F-keys, Space, etc.).
 */
export function isValidAccelerator(value: string): boolean {
  if (!value || value.length > 64) return false
  const parts = value.split('+').map((p) => p.trim())
  if (parts.some((p) => !p)) return false
  const keys = parts.filter((p) => !MODIFIERS.has(p.toLowerCase()))
  const mods = parts.length - keys.length
  if (keys.length !== 1 || mods < 1) return false
  return /^([A-Za-z0-9]|F\d{1,2}|Space|Tab|Enter|Return|Escape|Esc|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown|Plus|[`\-=\[\]\\;',./])$/.test(
    keys[0],
  )
}

function normalizeOne(value: unknown, fallback: string | null, allowFn: boolean): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return null
  if (allowFn && trimmed === FN_KEY) return FN_KEY
  return isValidAccelerator(trimmed) ? trimmed : fallback
}

export function normalizeDictationConfig(raw: unknown, base: DictationConfig = DEFAULT_DICTATION_CONFIG): DictationConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pushToTalk = 'pushToTalk' in input ? normalizeOne(input.pushToTalk, base.pushToTalk, true) : base.pushToTalk
  const handsFree = 'handsFree' in input ? normalizeOne(input.handsFree, base.handsFree, false) : base.handsFree
  // The same combo can't be both hold-to-talk and toggle.
  if (pushToTalk && handsFree && pushToTalk.toLowerCase() === handsFree.toLowerCase()) {
    return { pushToTalk, handsFree: null }
  }
  return { pushToTalk, handsFree }
}
