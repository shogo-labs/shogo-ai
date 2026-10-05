// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * "Local access" policy: which local macOS apps the agent may read or write,
 * folders it must stay out of, and whether it may drive the computer.
 *
 * This module is pure (no I/O, no logger) so the API can validate/persist the
 * preference and the permission engine can enforce it from one definition.
 * The renderer mirrors the shape in `apps/mobile/lib/local-access.ts`.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isWithinRoot } from './path-boundary'

export type LocalAppId = 'mail' | 'messages' | 'notes' | 'whatsapp'
export type AppAccess = 'off' | 'read' | 'readwrite'

export const LOCAL_APP_IDS: readonly LocalAppId[] = ['mail', 'messages', 'notes', 'whatsapp']

export interface LocalAccessPolicy {
  /** Per-app access. A missing app means "not configured" and is unrestricted. */
  apps?: Partial<Record<LocalAppId, AppAccess>>
  /**
   * Whether the `computer-use` MCP server (mouse, keyboard, screenshots) may be
   * used. `undefined` means never configured, which stays allowed so existing
   * installs keep working.
   */
  computerUse?: boolean
  /** Absolute folders the agent must not read, write or delete. */
  blockedFolders?: string[]
}

export interface DictationShortcuts {
  pushToTalk: string | null
  handsFree: string | null
}

/** What the API stores: the enforced policy plus UI-only dictation shortcuts. */
export interface LocalAccessPrefs {
  apps: Record<LocalAppId, AppAccess>
  computerUse: boolean
  blockedFolders: string[]
  dictation: DictationShortcuts
}

export const DEFAULT_LOCAL_ACCESS_PREFS: LocalAccessPrefs = {
  apps: { mail: 'read', messages: 'read', notes: 'read', whatsapp: 'read' },
  computerUse: false,
  blockedFolders: [],
  dictation: { pushToTalk: 'Fn', handsFree: null },
}

/** Directories (relative to `$HOME`) where each app keeps its data. */
export const APP_DATA_DIRS: Record<LocalAppId, string[]> = {
  mail: ['Library/Mail', 'Library/Containers/com.apple.mail'],
  messages: ['Library/Messages', 'Library/Containers/com.apple.iChat'],
  notes: [
    'Library/Group Containers/group.com.apple.notes',
    'Library/Containers/com.apple.Notes',
  ],
  whatsapp: [
    'Library/Group Containers/group.net.whatsapp.WhatsApp.shared',
    'Library/Containers/net.whatsapp.WhatsApp',
  ],
}

/** Display names used by AppleScript (`tell application "Mail"`) and `open -a`. */
const APP_SCRIPT_NAMES: Record<LocalAppId, string[]> = {
  mail: ['Mail'],
  messages: ['Messages'],
  notes: ['Notes'],
  whatsapp: ['WhatsApp'],
}

const ACCESS_VALUES: readonly AppAccess[] = ['off', 'read', 'readwrite']
const MAX_BLOCKED_FOLDERS = 100
const MAX_SHORTCUT_LENGTH = 64

function normalizeShortcut(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length <= MAX_SHORTCUT_LENGTH ? trimmed : fallback
}

/** Coerce untrusted input into a complete, valid preference object. */
export function normalizeLocalAccessPrefs(raw: unknown): LocalAccessPrefs {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const base = DEFAULT_LOCAL_ACCESS_PREFS

  const apps = { ...base.apps }
  if (input.apps && typeof input.apps === 'object') {
    for (const id of LOCAL_APP_IDS) {
      const value = input.apps[id]
      if (ACCESS_VALUES.includes(value)) apps[id] = value
    }
  }

  const blocked: string[] = []
  if (Array.isArray(input.blockedFolders)) {
    for (const entry of input.blockedFolders) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (trimmed && !blocked.includes(trimmed)) blocked.push(trimmed)
      if (blocked.length >= MAX_BLOCKED_FOLDERS) break
    }
  }

  const dictationInput = (input.dictation && typeof input.dictation === 'object' ? input.dictation : {}) as Record<
    string,
    unknown
  >
  const dictation: DictationShortcuts = {
    pushToTalk:
      'pushToTalk' in dictationInput
        ? normalizeShortcut(dictationInput.pushToTalk, base.dictation.pushToTalk)
        : base.dictation.pushToTalk,
    handsFree:
      'handsFree' in dictationInput
        ? normalizeShortcut(dictationInput.handsFree, base.dictation.handsFree)
        : base.dictation.handsFree,
  }

  return {
    apps,
    computerUse: typeof input.computerUse === 'boolean' ? input.computerUse : base.computerUse,
    blockedFolders: blocked,
    dictation,
  }
}

/** The enforceable subset of the stored preference. */
export function toLocalAccessPolicy(prefs: LocalAccessPrefs): LocalAccessPolicy {
  return { apps: { ...prefs.apps }, computerUse: prefs.computerUse, blockedFolders: [...prefs.blockedFolders] }
}

function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

export interface LocalAccessCheck {
  allowed: boolean
  reason?: string
  guidance?: string
}

const ALLOWED: LocalAccessCheck = { allowed: true }

export interface LocalAccessContext {
  homeDir?: string
  workspaceDir: string
}

type FileOp = 'read' | 'write' | 'delete'

/** Enforce app access and blocked folders for a file tool call. */
export function checkFileAccess(
  policy: LocalAccessPolicy | undefined,
  op: FileOp,
  filePath: string,
  ctx: LocalAccessContext,
): LocalAccessCheck {
  if (!policy || !filePath) return ALLOWED
  const home = ctx.homeDir ?? homedir()
  const resolved = resolve(ctx.workspaceDir, expandHome(filePath, home))

  for (const folder of policy.blockedFolders ?? []) {
    if (isWithinRoot(resolve(expandHome(folder, home)), resolved)) {
      return {
        allowed: false,
        reason: 'This folder is blocked in Shogo settings',
        guidance: 'The user blocked this folder. Do not try to access it another way.',
      }
    }
  }

  for (const id of LOCAL_APP_IDS) {
    const access = policy.apps?.[id]
    if (!access || access === 'readwrite') continue
    const inside = APP_DATA_DIRS[id].some((dir) => isWithinRoot(join(home, dir), resolved))
    if (!inside) continue
    if (access === 'off') {
      return {
        allowed: false,
        reason: `Access to ${id} data is turned off in Shogo settings`,
        guidance: `The user turned off ${id} access. Tell them they can enable it under Settings > Computer and files.`,
      }
    }
    if (op !== 'read') {
      return {
        allowed: false,
        reason: `${id} data is read-only in Shogo settings`,
        guidance: `The user allowed read-only access to ${id}. Do not modify or delete its data.`,
      }
    }
  }
  return ALLOWED
}

const MUTATING_SHELL_RE = /(^|[\s;&|])(rm|mv|cp|touch|tee|sed\s+-i|chmod|chown|truncate|dd|sqlite3|ln)\b|>>?\s*\S/

/**
 * Best-effort check of a shell command. Shell is not parseable in general, so
 * this only catches commands that literally name a protected directory, or
 * script a disabled app. It is a guardrail, not a sandbox.
 */
export function checkShellAccess(
  policy: LocalAccessPolicy | undefined,
  command: string,
  ctx: LocalAccessContext,
): LocalAccessCheck {
  if (!policy || !command) return ALLOWED
  const home = ctx.homeDir ?? homedir()
  const normalized = command.replace(/\$HOME|\$\{HOME\}/g, home).replace(/(^|[\s"'=])~\//g, `$1${home}/`)

  for (const folder of policy.blockedFolders ?? []) {
    const abs = resolve(expandHome(folder, home))
    if (abs && normalized.includes(abs)) {
      return {
        allowed: false,
        reason: 'This command touches a folder blocked in Shogo settings',
        guidance: 'The user blocked this folder. Do not try to access it another way.',
      }
    }
  }

  for (const id of LOCAL_APP_IDS) {
    const access = policy.apps?.[id]
    if (!access || access === 'readwrite') continue

    const touchesData = APP_DATA_DIRS[id].some((dir) => normalized.includes(join(home, dir)))
    const scriptsApp = APP_SCRIPT_NAMES[id].some((name) =>
      new RegExp(`(tell\\s+application\\s+[\\\\"']*${name}\\b)|(open\\s+-a\\s+[\\\\"']*${name}\\b)`, 'i').test(command),
    )

    if (access === 'off' && (touchesData || scriptsApp)) {
      return {
        allowed: false,
        reason: `Access to ${id} is turned off in Shogo settings`,
        guidance: `The user turned off ${id} access. Tell them they can enable it under Settings > Computer and files.`,
      }
    }
    if (access === 'read' && touchesData && MUTATING_SHELL_RE.test(command)) {
      return {
        allowed: false,
        reason: `${id} data is read-only in Shogo settings`,
        guidance: `The user allowed read-only access to ${id}. Do not modify or delete its data.`,
      }
    }
  }
  return ALLOWED
}

/** MCP servers that drive the whole computer. */
export const COMPUTER_USE_SERVERS: ReadonlySet<string> = new Set(['computer-use'])

export function checkComputerUse(policy: LocalAccessPolicy | undefined, serverName: string): LocalAccessCheck {
  if (!COMPUTER_USE_SERVERS.has(serverName)) return ALLOWED
  if (!policy || policy.computerUse !== false) return ALLOWED
  return {
    allowed: false,
    reason: 'Computer use is turned off in Shogo settings',
    guidance:
      'The user has not allowed Shogo to control this computer. Tell them to enable it under Settings > Computer and files (it needs Accessibility and Screen Recording access).',
  }
}
