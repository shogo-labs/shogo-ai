// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { ipcMain } from 'electron'

const CH = {
  streamCommand: 'shogo:llm:stream-command',
  openChatWithContext: 'shogo:llm:open-chat-with-context',
  delta: 'shogo:llm:stream-command:delta',
  done: 'shogo:llm:stream-command:done',
  error: 'shogo:llm:stream-command:error',
} as const

let registered = false

export function registerLlmIpcHandlers(): void {
  if (registered) return
  registered = true

  ipcMain.handle(CH.streamCommand, async (event, req: { requestId: string; prompt: string }) => {
    const wc = event.sender
    try {
      // Placeholder adapter until the app-level LLM service is centralized.
      const command = shellCommandFromPrompt(req.prompt)
      wc.send(CH.delta, { requestId: req.requestId, text: command })
      wc.send(CH.done, { requestId: req.requestId, text: command })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      wc.send(CH.error, { requestId: req.requestId, message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(CH.openChatWithContext, async (event, markdown: string) => {
    event.sender.send('shogo:chat:open-with-context', { markdown })
    return { ok: true }
  })
}

export function disposeLlmIpcHandlers(): void {
  if (!registered) return
  registered = false
  ipcMain.removeHandler(CH.streamCommand)
  ipcMain.removeHandler(CH.openChatWithContext)
}

function shellCommandFromPrompt(prompt: string): string {
  const p = prompt.trim()
  if (!p) return ''
  if (/list|show files|directory/i.test(p)) return 'ls -la'
  if (/git status/i.test(p)) return 'git status'
  if (/install/i.test(p)) return 'npm install'
  return `# ${p.replace(/\r?\n/g, ' ')}`
}

export const LLM_IPC_CHANNELS = CH
