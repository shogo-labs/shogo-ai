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
import { STREAM_WS_PATH } from './lib/meeting-stream-ticket'
import {
  isMeetingStreamSocketData,
  meetingStreamClose,
  meetingStreamMessage,
  meetingStreamOpen,
  meetingStreamSocketData,
} from './services/meeting-live-stream'
import { bootstrapLocalDatabase } from './lib/local-bootstrap'
import {
  createLocalPtyBridgeHandlers,
  isLocalPtyBridgeData,
  upgradeLocalPtySocket,
} from './routes/local-terminal'
import { countTerminalSession } from './lib/terminal-session-pin'
import { createLocalApp } from './app/create-local-app'
import { stopAllPrismaStudios } from './routes/database'
import { startLocalBackgroundWorkers, stopLocalBackgroundWorkers } from './lib/local-background-workers'
import { resolveLocalApiPort } from './lib/local-api-port'
import { prisma } from './lib/prisma'
import { isSecretCryptoConfigured } from './lib/secret-crypto'
import { ensureTranscriptionEngine } from './services/transcription-install.service'
import { startCloudWorkspaceSync } from './services/cloud-workspaces'
import { startInstanceTunnel, stopInstanceTunnel } from './lib/instance-tunnel'
import { startMachineSync, stopMachineSync } from './lib/machine-sync/local-sync'
import { conversationSocketHandlers, isConversationSocketData } from './realtime/conversation-socket'
import { cloudSocketRelayHandlers, isCloudSocketRelayData } from './routes/local-cloud-proxy'

const API_PORT = resolveLocalApiPort()
// Desktop provisions SECRETS_ENCRYPTION_KEY at API-bootstrap time; docker and
// self-host local mode do not (docker-compose.yml never sets it and
// .env.local.template leaves it blank), where it used to surface only as a UI
// error on the first credential write. Never log the key itself.
console.log(
  `[LocalAPI] secrets encryption: ${isSecretCryptoConfigured()
    ? 'configured'
    : 'NOT configured (SECRETS_ENCRYPTION_KEY unset or malformed) — provider keys, GitHub, Slack and integration credentials cannot be stored'}`,
)
const { app, runtimeManager, resetCaches: resetLocalCaches } = createLocalApp()

await bootstrapLocalDatabase()
resetLocalCaches()
// Every polling worker this process needs — the same list the cloud composer
// runs, so the slim local entrypoint cannot silently drop one again (SHO-36).
await startLocalBackgroundWorkers({ runtimeManager })
let stopComposioListener: (() => Promise<void>) | null = null
void import('./services/composio-triggers.service').then(async (m) => {
  const { installScriptedEventAgentFromEnv } = await import('./services/event-agent-script')
  installScriptedEventAgentFromEnv()
  m.startComposioTriggerReconciler()
  stopComposioListener = await m.startComposioTriggerListener()
}).catch((err) => console.warn('[LocalAPI] Composio trigger listener unavailable:', err?.message ?? err))
// Keep the cloud team workspaces this desktop is signed in to current.
startCloudWorkspaceSync()

const ptyBridge = createLocalPtyBridgeHandlers()
const server = Bun.serve({
  port: API_PORT,
  fetch: async (req, bunServer) => {
    // Live meeting transcript audio. Auth is a signed ticket in the URL.
    if (new URL(req.url).pathname === STREAM_WS_PATH && req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const data = meetingStreamSocketData(new URL(req.url))
      if (!data) return new Response('Unauthorized', { status: 401 })
      if ((bunServer as any).upgrade(req, { data })) return undefined
      return new Response('WebSocket upgrade failed', { status: 500 })
    }
    const upgrade = await upgradeLocalPtySocket(req, bunServer, runtimeManager)
    if (upgrade !== null) return upgrade
    return app.fetch(req, bunServer)
  },
  websocket: {
    open(ws: any) {
      if (isConversationSocketData(ws.data)) conversationSocketHandlers.open(ws)
      else if (isCloudSocketRelayData(ws.data)) cloudSocketRelayHandlers.open(ws)
      else if (isMeetingStreamSocketData(ws.data)) meetingStreamOpen(ws)
      else if (isLocalPtyBridgeData(ws.data)) {
        countTerminalSession(runtimeManager, ws.data, 1)
        ptyBridge.open(ws)
      }
    },
    message(ws: any, message: any) {
      if (isConversationSocketData(ws.data)) void conversationSocketHandlers.message(ws, message)
      else if (isCloudSocketRelayData(ws.data)) cloudSocketRelayHandlers.message(ws, message)
      else if (isMeetingStreamSocketData(ws.data)) meetingStreamMessage(ws, message)
      else if (isLocalPtyBridgeData(ws.data)) ptyBridge.message(ws, message)
    },
    close(ws: any, code?: number, reason?: string) {
      if (isConversationSocketData(ws.data)) conversationSocketHandlers.close(ws)
      else if (isCloudSocketRelayData(ws.data)) cloudSocketRelayHandlers.close(ws)
      else if (isMeetingStreamSocketData(ws.data)) meetingStreamClose(ws)
      else if (isLocalPtyBridgeData(ws.data)) {
        countTerminalSession(runtimeManager, ws.data, -1)
        ptyBridge.close(ws, code, reason)
      }
    },
  },
  idleTimeout: 255,
})

console.log(`🚀 Local API server running on http://localhost:${server.port}`)
console.log(`   Workspace runtime: ws:proj:<anchor>`)

// Registers this machine with Shogo Cloud (heartbeat + on-demand WS). The
// tunnel proxies cloud requests back to this server, so start it after listen.
if (process.env.SHOGO_API_KEY) startInstanceTunnel()
// Keeps the cloud's copy of this machine's records current over HTTPS, off every
// request path (SHO-185). Waits for the first heartbeat to learn its id.
if (process.env.SHOGO_API_KEY) {
  void startMachineSync().catch((err) => {
    console.warn('[LocalAPI] Machine sync did not start:', err?.message ?? err)
  })
}

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
  stopLocalBackgroundWorkers()
  stopMachineSync()
  stopInstanceTunnel()
  void stopComposioListener?.()
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
