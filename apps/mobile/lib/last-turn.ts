// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The last thing an agent did in a chat, boiled down for a quick look: what it
 * was asked, the commands and tools it ran, the files it changed, and its
 * answer. Pure; the peek sheet loads the messages and renders the result.
 */

export interface TurnMessage {
  id: string
  role: string
  parts?: unknown[]
}

export interface TurnStep {
  id: string
  /** "Run a command", "Edit a file", or the tool's own name. */
  label: string
  /** The command, path or query, when there is one. */
  detail: string
  state: 'running' | 'done' | 'failed'
}

export interface TurnFileChange {
  toolName: string
  params: Record<string, unknown>
}

export interface LastTurn {
  prompt: string
  steps: TurnStep[]
  /** Edits and writes, in order, for the diff view. */
  changes: TurnFileChange[]
  answer: string
  /** The agent is still working on this turn. */
  running: boolean
}

const MAX_DETAIL = 160

const TOOL_LABEL: Record<string, string> = {
  exec: 'Run a command',
  shell: 'Run a command',
  bash: 'Run a command',
  run_command: 'Run a command',
  write_file: 'Write a file',
  create_file: 'Write a file',
  edit_file: 'Edit a file',
  str_replace: 'Edit a file',
  read_file: 'Read a file',
  search: 'Search',
  web_search: 'Search the web',
}

const EDIT_TOOLS = /^(edit_file|str_replace|write_file|create_file|apply_patch|edit|write)$/i

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

function toolNameOf(part: Record<string, unknown>): string | null {
  const type = typeof part.type === 'string' ? part.type : ''
  if (type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : null
  if (type.startsWith('tool-')) return type.slice('tool-'.length)
  return null
}

function detailOf(params: Record<string, unknown>): string {
  for (const key of ['command', 'path', 'file_path', 'target_file', 'url', 'query']) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return clip(value.trim().split('\n')[0], MAX_DETAIL)
  }
  return ''
}

function stateOf(part: Record<string, unknown>): TurnStep['state'] {
  const state = typeof part.state === 'string' ? part.state : ''
  if (state === 'output-error' || state === 'error') return 'failed'
  if (state === 'output-available' || state === 'result') return 'done'
  return part.output !== undefined ? 'done' : 'running'
}

const textOf = (message: TurnMessage): string =>
  (message.parts ?? [])
    .map(record)
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => (p.text as string).trim())
    .filter(Boolean)
    .join('\n\n')

/** The newest turn in a chat, or null when the chat has no user message yet. */
export function summarizeLastTurn(messages: readonly TurnMessage[]): LastTurn | null {
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      start = i
      break
    }
  }
  if (start < 0) return null

  const prompt = textOf(messages[start])
  const replies = messages.slice(start + 1).filter((m) => m.role === 'assistant')
  const steps: TurnStep[] = []
  const changes: TurnFileChange[] = []

  for (const reply of replies) {
    for (const raw of reply.parts ?? []) {
      const part = record(raw)
      const name = toolNameOf(part)
      if (!name) continue
      const params = record(part.input ?? part.args)
      const id = typeof part.toolCallId === 'string' ? part.toolCallId : `${reply.id}:${steps.length}`
      steps.push({ id, label: TOOL_LABEL[name] ?? name.replace(/_/g, ' '), detail: detailOf(params), state: stateOf(part) })
      if (EDIT_TOOLS.test(name) && Object.keys(params).length) changes.push({ toolName: name, params })
    }
  }

  const lastReply = replies[replies.length - 1]
  const answer = lastReply ? textOf(lastReply) : ''
  const running = steps.some((s) => s.state === 'running')
  return { prompt, steps, changes, answer, running }
}
