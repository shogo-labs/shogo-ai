// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Slash-command parsing for the interactive agent REPL.
 *
 * Mirrors the small, hardcoded command set in the plan (Claude Code ships a
 * full registry in `src/commands.ts`; we start minimal and can grow into a
 * registry later). Pure + side-effect free so it is unit-testable.
 */

export type SlashCommand =
  | { type: 'exit' }
  | { type: 'clear' }
  | { type: 'help' }
  | { type: 'cwd' }
  | { type: 'model'; model?: string }
  /** Input was not a slash command — treat the raw text as a prompt. */
  | { type: 'prompt'; text: string }
  /** Started with `/` but is not a known command. */
  | { type: 'unknown'; name: string }

/** Commands shown by `/help`, in display order. */
export const SLASH_COMMAND_HELP: ReadonlyArray<{ name: string; description: string }> = [
  { name: '/help', description: 'Show available commands' },
  { name: '/model [name]', description: 'Show or set the model for new turns' },
  { name: '/clear', description: 'Start a fresh conversation' },
  { name: '/cwd', description: 'Print the working directory' },
  { name: '/exit', description: 'Exit the agent (also: Ctrl-C on an empty prompt)' },
]

export function parseSlashCommand(input: string): SlashCommand {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) {
    return { type: 'prompt', text: input }
  }

  const withoutSlash = trimmed.slice(1)
  const spaceIdx = withoutSlash.search(/\s/)
  const name = (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase()
  const rest = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim()

  switch (name) {
    case 'exit':
    case 'quit':
    case 'q':
      return { type: 'exit' }
    case 'clear':
    case 'new':
      return { type: 'clear' }
    case 'help':
    case '?':
      return { type: 'help' }
    case 'cwd':
    case 'pwd':
      return { type: 'cwd' }
    case 'model':
      return { type: 'model', model: rest || undefined }
    default:
      return { type: 'unknown', name }
  }
}
