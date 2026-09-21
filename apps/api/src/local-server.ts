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

const API_PORT = Number(process.env.API_PORT || process.env.PORT || 39100)
const { app, runtimeManager, resetCaches: resetLocalCaches } = createLocalApp()

await bootstrapLocalDatabase()
resetLocalCaches()

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
      if (isLocalPtyBridgeData(ws.data)) ptyBridge.open(ws)
    },
    message(ws: any, message: any) {
      if (isLocalPtyBridgeData(ws.data)) ptyBridge.message(ws, message)
    },
    close(ws: any, code?: number, reason?: string) {
      if (isLocalPtyBridgeData(ws.data)) ptyBridge.close(ws, code, reason)
    },
  },
  idleTimeout: 255,
})

console.log(`🚀 Local API server running on http://localhost:${server.port}`)
console.log(`   Workspace runtime: ws:proj:<anchor>`)

async function shutdown(signal: string): Promise<void> {
  console.log(`[LocalAPI] Received ${signal}, stopping runtimes...`)
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
