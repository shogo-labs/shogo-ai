// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Slim local/desktop API composer.
 *
 * Cloud deployment keeps the compatibility-heavy composer in `server.ts`.
 * Desktop only needs the workspace/runtime, local setup, project, chat, IDE,
 * and generated CRUD surfaces below. Keeping this entrypoint separate is the
 * architectural boundary that makes the local bundle tree-shakeable instead
 * of merely hiding cloud routes behind runtime `if` statements.
 */
import { bootstrapLocalDatabase } from './lib/local-bootstrap'
import {
  createLocalPtyBridgeHandlers,
  isLocalPtyBridgeData,
  upgradeLocalPtySocket,
} from './routes/local-terminal'
import { createLocalApp } from './app/create-local-app'
import { stopAllPrismaStudios } from './routes/database'
import { startAgentScheduleWorker, stopAgentScheduleWorker } from './jobs/run-agent-schedule-dispatch'
import { startChatQueueWorker, stopChatQueueWorker } from './jobs/run-chat-queue-drain'
import { startChannelWorkers, stopChannelWorkers } from './jobs/run-channel-workers'
import { resolveLocalApiPort } from './lib/local-api-port'
import { prisma } from './lib/prisma'
import { ensureTranscriptionEngine } from './services/transcription-install.service'
import { startCloudWorkspaceSync } from './services/cloud-workspaces'
import { conversationSocketHandlers, isConversationSocketData } from './realtime/conversation-socket'
import { cloudSocketRelayHandlers, isCloudSocketRelayData } from './routes/local-cloud-proxy'

const API_PORT = resolveLocalApiPort()
const { app, runtimeManager, resetCaches: resetLocalCaches } = createLocalApp()

await bootstrapLocalDatabase()
resetLocalCaches()
// Fire due agent-owned recurring schedules in the local workspace runtime.
startAgentScheduleWorker(runtimeManager)
startChatQueueWorker()
startChannelWorkers()
// Keep the cloud team workspaces this desktop is signed in to current.
startCloudWorkspaceSync()

const ptyBridge = createLocalPtyBridgeHandlers()
const server = Bun.serve({
  port: API_PORT,
  fetch: async (req, bunServer) => {
    const upgrade = await upgradeLocalPtySocket(req, bunServer, runtimeManager)
    if (upgrade !== null) return upgrade
    return app.fetch(req, bunServer)
  },
  websocket: {
    open(ws: any) {
      if (isConversationSocketData(ws.data)) conversationSocketHandlers.open(ws)
      else if (isCloudSocketRelayData(ws.data)) cloudSocketRelayHandlers.open(ws)
      else if (isLocalPtyBridgeData(ws.data)) ptyBridge.open(ws)
    },
    message(ws: any, message: any) {
      if (isConversationSocketData(ws.data)) void conversationSocketHandlers.message(ws, message)
      else if (isCloudSocketRelayData(ws.data)) cloudSocketRelayHandlers.message(ws, message)
      else if (isLocalPtyBridgeData(ws.data)) ptyBridge.message(ws, message)
    },
    close(ws: any, code?: number, reason?: string) {
      if (isConversationSocketData(ws.data)) conversationSocketHandlers.close(ws)
      else if (isCloudSocketRelayData(ws.data)) cloudSocketRelayHandlers.close(ws)
      else if (isLocalPtyBridgeData(ws.data)) ptyBridge.close(ws, code, reason)
    },
  },
  idleTimeout: 255,
})

console.log(`🚀 Local API server running on http://localhost:${server.port}`)
console.log(`   Workspace runtime: ws:proj:<anchor>`)

async function startBackgroundTranscriptionSetup(): Promise<void> {
  try {
    const rows = await (prisma as any).localConfig.findMany({
      where: { key: { in: ['MEETING_ENABLED', 'MEETING_WHISPER_MODEL'] } },
    })
    const config = Object.fromEntries(rows.map((row: { key: string; value: string }) => [row.key, row.value]))
    if (config.MEETING_ENABLED === 'false') return
    const model = config.MEETING_WHISPER_MODEL || 'base.en'
    setTimeout(() => {
      void ensureTranscriptionEngine(model).catch((err) => {
        console.warn('[LocalAPI] Background transcription setup failed:', err?.message ?? err)
      })
    }, 1_000)
  } catch (err: any) {
    console.warn('[LocalAPI] Could not schedule transcription setup:', err?.message ?? err)
  }
}

void startBackgroundTranscriptionSetup()

async function shutdown(signal: string): Promise<void> {
  console.log(`[LocalAPI] Received ${signal}, stopping runtimes...`)
  stopAgentScheduleWorker()
  stopChatQueueWorker()
  stopChannelWorkers()
  try {
    await runtimeManager.stopAll()
    stopAllPrismaStudios()
    server.stop(true)
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

export default server
