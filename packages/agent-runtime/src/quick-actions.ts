// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Quick Actions
 *
 * Quick actions are user-facing prompt shortcuts stored in
 * .shogo/quick-actions.json. The agent registers them via the
 * `quick_action` tool; the mobile UI renders them as clickable chips.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuickAction {
  label: string
  prompt: string
}

interface QuickActionsFile {
  actions: QuickAction[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUICK_ACTIONS_PATH = '.shogo/quick-actions.json'
const MAX_ACTIONS = 10
const MAX_LABEL_LENGTH = 20

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export function loadQuickActions(workspaceDir: string): QuickAction[] {
  const filePath = join(workspaceDir, QUICK_ACTIONS_PATH)
  if (!existsSync(filePath)) return []
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    if (!Array.isArray(raw?.actions)) return []
    return raw.actions.filter(
      (a: any) => typeof a?.label === 'string' && typeof a?.prompt === 'string',
    )
  } catch {
    return []
  }
}

export function saveQuickActions(workspaceDir: string, actions: QuickAction[]): void {
  const filePath = join(workspaceDir, QUICK_ACTIONS_PATH)
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const data: QuickActionsFile = { actions }
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

export function addQuickAction(
  workspaceDir: string,
  action: QuickAction,
): { ok: boolean; actions: QuickAction[]; errors?: string[] } {
  const existing = loadQuickActions(workspaceDir)
  const filtered = existing.filter((a) => a.label !== action.label)
  const updated = [...filtered, action]

  const { valid, errors } = validateQuickActionsArray(updated)
  if (!valid) {
    return { ok: false, actions: existing, errors }
  }

  saveQuickActions(workspaceDir, updated)
  return { ok: true, actions: updated }
}

// ---------------------------------------------------------------------------
// Validation (file-level linter)
// ---------------------------------------------------------------------------

export function validateQuickActions(content: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  let parsed: any
  try {
    parsed = JSON.parse(content)
  } catch (e: any) {
    return { valid: false, errors: [`Invalid JSON: ${e.message}`] }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { valid: false, errors: ['Root must be an object with an "actions" array'] }
  }

  const allowedRootKeys = new Set(['actions'])
  for (const key of Object.keys(parsed)) {
    if (!allowedRootKeys.has(key)) {
      errors.push(`Unexpected root key "${key}" — only "actions" is allowed`)
    }
  }

  if (!Array.isArray(parsed.actions)) {
    errors.push('"actions" must be an array')
    return { valid: false, errors }
  }

  return validateQuickActionsArray(parsed.actions, errors)
}

function validateQuickActionsArray(
  actions: any[],
  errors: string[] = [],
): { valid: boolean; errors: string[] } {
  if (actions.length > MAX_ACTIONS) {
    errors.push(`Too many actions: ${actions.length} (max ${MAX_ACTIONS})`)
  }

  const seenLabels = new Set<string>()
  const allowedKeys = new Set(['label', 'prompt'])

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]
    if (typeof a !== 'object' || a === null || Array.isArray(a)) {
      errors.push(`actions[${i}]: must be an object with "label" and "prompt"`)
      continue
    }

    for (const key of Object.keys(a)) {
      if (!allowedKeys.has(key)) {
        errors.push(`actions[${i}]: unexpected field "${key}" — only "label" and "prompt" allowed`)
      }
    }

    if (typeof a.label !== 'string' || !a.label.trim()) {
      errors.push(`actions[${i}]: "label" must be a non-empty string`)
    } else {
      if (a.label.length > MAX_LABEL_LENGTH) {
        errors.push(`actions[${i}]: label "${a.label}" exceeds ${MAX_LABEL_LENGTH} characters`)
      }
      if (seenLabels.has(a.label)) {
        errors.push(`actions[${i}]: duplicate label "${a.label}"`)
      }
      seenLabels.add(a.label)
    }

    if (typeof a.prompt !== 'string' || !a.prompt.trim()) {
      errors.push(`actions[${i}]: "prompt" must be a non-empty string`)
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Prompt section builder (injected per-turn so the agent sees current state)
// ---------------------------------------------------------------------------

export function buildQuickActionsPromptSection(actions: QuickAction[]): string | null {
  if (actions.length === 0) return null

  const lines = [
    '## Registered Quick Actions',
    '',
    'The following quick actions are currently registered and visible to the user:',
    '',
  ]

  for (const a of actions) {
    lines.push(`- **${a.label}**: "${a.prompt}"`)
  }

  lines.push('')
  lines.push('Do not re-register actions that already exist. To update an action, edit `.shogo/quick-actions.json` directly.')

  return lines.join('\n')
}
