// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { HookEvent } from '../../types'

const handler = async (event: HookEvent): Promise<void> => {
  if (event.type !== 'command') return

  const workspaceDir = event.context.workspaceDir as string | undefined
  if (!workspaceDir) return

  const logsDir = join(workspaceDir, 'logs')
  mkdirSync(logsDir, { recursive: true })

  const logPath = join(logsDir, 'commands.log')
  const entry = JSON.stringify({
    timestamp: event.timestamp.toISOString(),
    action: event.action,
    sessionKey: event.sessionKey,
    senderId: event.context.senderId,
    source: event.context.channelType,
  })

  appendFileSync(logPath, entry + '\n', 'utf-8')
}

export default handler
