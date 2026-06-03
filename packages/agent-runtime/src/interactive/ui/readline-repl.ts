// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Plain readline REPL — the dependency-free fallback used when stdin/stdout
 * are not a TTY or `--no-tui` is set (and as a safety net if Ink fails to
 * load). Streams assistant text and tool activity straight to stdout.
 */

import { createInterface, type Interface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { createTurnStore } from '../terminal-writer'
import { parseSlashCommand, SLASH_COMMAND_HELP } from '../slash-commands'
import type { InteractiveGateway } from '../run'

export interface ReplOptions {
  gateway: InteractiveGateway
  cwd: string
  model?: string
  sessionId: string
}

const ESC = '\x1b['
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`
const red = (s: string) => `${ESC}31m${s}${ESC}0m`

function question(rl: Interface, prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false
    const onClose = () => {
      if (!answered) resolve(null)
    }
    rl.once('close', onClose)
    rl.question(prompt, (answer) => {
      answered = true
      rl.removeListener('close', onClose)
      resolve(answer)
    })
  })
}

export async function runReadlineRepl(options: ReplOptions): Promise<void> {
  const { gateway } = options
  let sessionId = options.sessionId
  let model = options.model

  const out = process.stdout
  out.write(`\n${bold('Shogo')} ${dim('interactive agent')}\n`)
  out.write(`${dim('  cwd:   ')}${options.cwd}\n`)
  out.write(`${dim('  model: ')}${model ?? 'default'}\n`)
  out.write(`${dim("  Type a message, or /help for commands. Ctrl-C to stop a turn or exit.")}\n\n`)

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  let busy = false
  rl.on('SIGINT', () => {
    if (busy) {
      gateway.abortCurrentTurn?.(sessionId)
      out.write(dim('\n(interrupted)\n'))
    } else {
      out.write('\n')
      rl.close()
    }
  })

  for (;;) {
    const input = await question(rl, cyan('› '))
    if (input === null) break // EOF / closed
    const text = input.trim()
    if (!text) continue

    const cmd = parseSlashCommand(input)
    if (cmd.type === 'exit') break
    if (cmd.type === 'help') {
      for (const c of SLASH_COMMAND_HELP) out.write(`  ${bold(c.name.padEnd(16))} ${dim(c.description)}\n`)
      out.write('\n')
      continue
    }
    if (cmd.type === 'cwd') {
      out.write(`  ${options.cwd}\n\n`)
      continue
    }
    if (cmd.type === 'clear') {
      sessionId = randomUUID()
      try {
        await gateway.stop?.()
      } catch {
        /* no-op: stop is best effort */
      }
      out.write(dim('  Started a fresh conversation.\n\n'))
      continue
    }
    if (cmd.type === 'model') {
      if (cmd.model) {
        model = cmd.model
        out.write(dim(`  Model set to ${model}.\n\n`))
      } else {
        out.write(`  ${model ?? 'default'}\n\n`)
      }
      continue
    }
    if (cmd.type === 'unknown') {
      out.write(red(`  Unknown command /${cmd.name}. Try /help.\n\n`))
      continue
    }

    // A real prompt — run a turn.
    busy = true
    const store = createTurnStore({
      onEvent: (event) => {
        switch (event.type) {
          case 'text-delta':
            out.write(event.delta)
            break
          case 'tool-start':
            out.write(dim(`\n  ⚙ ${event.toolName}…\n`))
            break
          case 'tool-end':
            out.write(dim(`  ${event.status === 'error' ? '✗' : '✓'} ${event.toolCallId}\n`))
            break
          case 'error':
            out.write(red(`\n  ${event.text}\n`))
            break
          default:
            break
        }
      },
    })

    try {
      await gateway.processChatMessageStream(cmd.text, store, {
        chatSessionId: sessionId,
        interactionMode: 'agent',
        modelOverride: model,
      })
    } catch (e: any) {
      out.write(red(`\n  ${e?.message ?? e}\n`))
    } finally {
      busy = false
    }
    out.write('\n\n')
  }

  rl.close()
}
