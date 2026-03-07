// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { HookEvent } from '../../types'

const handler = async (event: HookEvent): Promise<void> => {
  if (event.type !== 'command' || event.action !== 'new') return

  const workspaceDir = event.context.workspaceDir as string | undefined
  const messages = event.context.sessionMessages as Array<{ role: string; content: any }> | undefined
  if (!workspaceDir || !messages || messages.length === 0) return

  const memoryDir = join(workspaceDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })

  const now = new Date()
  const date = now.toISOString().split('T')[0]
  const time = now.toISOString().split('T')[1].split('.')[0].replace(/:/g, '')

  const lastMessages = messages.slice(-10)
  const summary = lastMessages
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return `**${m.role}**: ${content.substring(0, 200)}`
    })
    .join('\n\n')

  const filename = `${date}-session-${time}.md`
  const filePath = join(memoryDir, filename)

  const fileContent = `# Session: ${now.toISOString()}\n\n${summary}\n`
  writeFileSync(filePath, fileContent, 'utf-8')

  event.messages.push(`Session saved to memory/${filename}`)
}

export default handler
