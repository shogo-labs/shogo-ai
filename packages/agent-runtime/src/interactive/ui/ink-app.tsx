// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Ink + React terminal UI for the interactive agent, modeled on Claude Code
 * (`~/git/claude-code-source`): an `<App>` shell, a `<Static>` transcript for
 * finalized turns (printed once into scrollback), a live region for the
 * in-progress turn, per-part rows, a working spinner, and a prompt input.
 *
 * Loaded only on a TTY (and dynamically imported by `run.ts`), so the server
 * boot path and tests never pull in React/Ink.
 */

import React, { useCallback, useRef, useState } from 'react'
import { render, Box, Text, Static, useApp, useInput } from 'ink'
import { randomUUID } from 'node:crypto'
import { createTurnStore, type Entry } from '../terminal-writer'
import { parseSlashCommand, SLASH_COMMAND_HELP } from '../slash-commands'
import type { InteractiveGateway } from '../run'

export interface InkReplOptions {
  gateway: InteractiveGateway
  cwd: string
  model?: string
  sessionId: string
}

interface HistoryItem {
  key: string
  kind: 'user' | 'assistant' | 'system'
  text?: string
  entries?: Entry[]
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function useSpinnerFrame(active: boolean): string {
  const [frame, setFrame] = useState(0)
  React.useEffect(() => {
    if (!active) return
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(t)
  }, [active])
  return SPINNER_FRAMES[frame]!
}

function EntryRow({ entry }: { entry: Entry }): React.ReactElement | null {
  switch (entry.kind) {
    case 'text':
      return <Text>{entry.text}</Text>
    case 'reasoning':
      return <Text dimColor>{entry.text}</Text>
    case 'tool': {
      const glyph = entry.status === 'running' ? '⚙' : entry.status === 'error' ? '✗' : '✓'
      return (
        <Text dimColor>
          {`  ${glyph} ${entry.toolName}`}
          {entry.status === 'running' ? '…' : ''}
        </Text>
      )
    }
    case 'error':
      return <Text color="red">{`  ${entry.text}`}</Text>
    default:
      return null
  }
}

function EntryList({ entries }: { entries: readonly Entry[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {entries.map((e, i) => (
        <EntryRow key={`${e.kind}-${e.id}-${i}`} entry={e} />
      ))}
    </Box>
  )
}

function HistoryRow({ item }: { item: HistoryItem }): React.ReactElement {
  if (item.kind === 'user') {
    return (
      <Box marginTop={1}>
        <Text color="cyan">{'› '}</Text>
        <Text>{item.text}</Text>
      </Box>
    )
  }
  if (item.kind === 'system') {
    return (
      <Text dimColor>{item.text}</Text>
    )
  }
  return (
    <Box marginTop={1}>
      <EntryList entries={item.entries ?? []} />
    </Box>
  )
}

function App({ gateway, cwd, model: initialModel, sessionId: initialSessionId }: InkReplOptions): React.ReactElement {
  const { exit } = useApp()
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [liveEntries, setLiveEntries] = useState<readonly Entry[]>([])
  const [model, setModel] = useState<string | undefined>(initialModel)

  const sessionRef = useRef(initialSessionId)
  const spinner = useSpinnerFrame(busy)

  const pushSystem = useCallback((text: string) => {
    setHistory((h) => [...h, { key: `sys-${h.length}-${Date.now()}`, kind: 'system', text }])
  }, [])

  const runTurn = useCallback(
    async (prompt: string) => {
      setHistory((h) => [...h, { key: `usr-${h.length}-${Date.now()}`, kind: 'user', text: prompt }])
      setBusy(true)
      const store = createTurnStore()
      const unsubscribe = store.subscribe(() => setLiveEntries([...store.getEntries()]))
      try {
        await gateway.processChatMessageStream(prompt, store, {
          chatSessionId: sessionRef.current,
          interactionMode: 'agent',
          modelOverride: model,
        })
      } catch (e: any) {
        store.write({ type: 'error', errorText: e?.message ?? String(e) })
      } finally {
        unsubscribe()
        const finalEntries = [...store.getEntries()]
        setHistory((h) => [...h, { key: `ast-${h.length}-${Date.now()}`, kind: 'assistant', entries: finalEntries }])
        setLiveEntries([])
        setBusy(false)
      }
    },
    [gateway, model],
  )

  const submit = useCallback(
    (raw: string) => {
      const cmd = parseSlashCommand(raw)
      switch (cmd.type) {
        case 'exit':
          exit()
          return
        case 'help':
          pushSystem(SLASH_COMMAND_HELP.map((c) => `  ${c.name.padEnd(16)} ${c.description}`).join('\n'))
          return
        case 'cwd':
          pushSystem(`  ${cwd}`)
          return
        case 'clear':
          sessionRef.current = randomUUID()
          void gateway.stop?.().catch(() => {})
          pushSystem('  Started a fresh conversation.')
          return
        case 'model':
          if (cmd.model) {
            setModel(cmd.model)
            pushSystem(`  Model set to ${cmd.model}.`)
          } else {
            pushSystem(`  ${model ?? 'default'}`)
          }
          return
        case 'unknown':
          pushSystem(`  Unknown command /${cmd.name}. Try /help.`)
          return
        case 'prompt':
          void runTurn(cmd.text)
          return
      }
    },
    [cwd, exit, gateway, model, pushSystem, runTurn],
  )

  useInput((value, key) => {
    if (busy) {
      // While a turn is running, Esc / Ctrl-C abort it (input is ignored).
      if (key.escape || (key.ctrl && value === 'c')) {
        gateway.abortCurrentTurn?.(sessionRef.current)
      }
      return
    }

    if (key.ctrl && value === 'c') {
      if (input.length === 0) {
        exit()
      } else {
        setInput('')
      }
      return
    }
    if (key.return) {
      const text = input
      setInput('')
      if (text.trim()) submit(text)
      return
    }
    if (key.backspace || key.delete) {
      setInput((v) => v.slice(0, -1))
      return
    }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      return
    }
    if (value) setInput((v) => v + value)
  })

  return (
    <Box flexDirection="column">
      <Static items={history}>{(item) => <HistoryRow key={item.key} item={item} />}</Static>

      {busy && liveEntries.length > 0 && (
        <Box marginTop={1}>
          <EntryList entries={liveEntries} />
        </Box>
      )}

      <Box marginTop={1}>
        {busy ? (
          <Text>
            <Text color="yellow">{spinner}</Text>
            <Text dimColor> working… (esc to interrupt)</Text>
          </Text>
        ) : (
          <Text>
            <Text color="cyan">{'› '}</Text>
            <Text>{input}</Text>
            <Text dimColor>▌</Text>
          </Text>
        )}
      </Box>
    </Box>
  )
}

export async function runInkRepl(options: InkReplOptions): Promise<void> {
  const banner =
    `\n\x1b[1mShogo\x1b[0m \x1b[2minteractive agent\x1b[0m\n` +
    `\x1b[2m  cwd:   \x1b[0m${options.cwd}\n` +
    `\x1b[2m  model: \x1b[0m${options.model ?? 'default'}\n` +
    `\x1b[2m  Type a message, or /help for commands.\x1b[0m\n`
  process.stdout.write(banner)
  const instance = render(<App {...options} />)
  await instance.waitUntilExit()
}
