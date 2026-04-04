#!/usr/bin/env bun
/**
 * Quick sync() integration test — run inside Docker:
 *   docker exec sync-test bun run /app/packages/agent-runtime/src/__tests__/test-sync-quick.ts
 *
 * Tests the exact flow that evals use:
 *   1. Write schema with one model → sync() → expect healthy
 *   2. Edit schema to add more models → sync() → expect healthy (no timeout)
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { SkillServerManager } from '../skill-server-manager'

const WORKSPACE = '/tmp/sync-test-' + Date.now()
const SERVER_DIR = join(WORKSPACE, '.shogo', 'server')
const PORT = 14100

async function main() {
  mkdirSync(SERVER_DIR, { recursive: true })

  const mgr = new SkillServerManager({ workspaceDir: WORKSPACE, port: PORT })

  try {
    // ── Step 1: Write initial schema with one model ──
    console.log('\n=== STEP 1: Initial schema (Client only) ===')
    const schema1 = `
datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

model Client {
  id    String @id @default(cuid())
  name  String
  email String
  createdAt DateTime @default(now())
}
`
    writeFileSync(join(SERVER_DIR, 'schema.prisma'), schema1)

    console.log('Starting server manager...')
    const t0 = Date.now()
    const startResult = await mgr.start()
    console.log(`start() took ${((Date.now() - t0) / 1000).toFixed(1)}s → phase=${mgr.phase}, running=${mgr.isRunning}`)
    console.log('Start result:', JSON.stringify(startResult))

    // Test the route
    if (mgr.isRunning) {
      try {
        const r = await fetch(`http://localhost:${PORT}/api/clients`)
        console.log(`GET /api/clients → ${r.status}`)
      } catch (e: any) {
        console.log(`GET /api/clients → ERROR: ${e.message}`)
      }
    }

    // ── Step 2: Edit schema to add Deal model ──
    console.log('\n=== STEP 2: Edit schema (add Deal model) ===')
    const schema2 = `
datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

model Client {
  id    String @id @default(cuid())
  name  String
  email String
  deals Deal[]
  createdAt DateTime @default(now())
}

model Deal {
  id       String @id @default(cuid())
  name     String
  value    Int
  clientId String
  client   Client @relation(fields: [clientId], references: [id])
  createdAt DateTime @default(now())
}
`
    writeFileSync(join(SERVER_DIR, 'schema.prisma'), schema2)

    console.log('Calling sync()...')
    const t1 = Date.now()
    const syncResult = await mgr.sync()
    console.log(`sync() took ${((Date.now() - t1) / 1000).toFixed(1)}s → ${JSON.stringify(syncResult)}`)

    // Test both routes
    if (syncResult.ok) {
      for (const route of ['/api/clients', '/api/deals']) {
        try {
          const r = await fetch(`http://localhost:${PORT}${route}`)
          console.log(`GET ${route} → ${r.status}`)
        } catch (e: any) {
          console.log(`GET ${route} → ERROR: ${e.message}`)
        }
      }
    }

    // ── Step 3: Add a third model ──
    console.log('\n=== STEP 3: Edit schema (add Project model) ===')
    const schema3 = schema2.replace(
      '}\n',
      `}

model Project {
  id     String @id @default(cuid())
  title  String
  status String @default("planning")
  createdAt DateTime @default(now())
}
`,
    )
    writeFileSync(join(SERVER_DIR, 'schema.prisma'), schema3)

    console.log('Calling sync()...')
    const t2 = Date.now()
    const syncResult2 = await mgr.sync()
    console.log(`sync() took ${((Date.now() - t2) / 1000).toFixed(1)}s → ${JSON.stringify(syncResult2)}`)

    // Test all routes
    if (syncResult2.ok) {
      for (const route of ['/api/clients', '/api/deals', '/api/projects']) {
        try {
          const r = await fetch(`http://localhost:${PORT}${route}`)
          console.log(`GET ${route} → ${r.status}`)
        } catch (e: any) {
          console.log(`GET ${route} → ERROR: ${e.message}`)
        }
      }
    }

    // Report active routes
    console.log('\n=== Active routes ===')
    console.log(mgr.getActiveRoutes())
    console.log(mgr.getSchemaModels())

    // Check server log for errors
    const logPath = join(SERVER_DIR, '.server.log')
    if (existsSync(logPath)) {
      console.log('\n=== Server log (last 30 lines) ===')
      const log = readFileSync(logPath, 'utf-8')
      const lines = log.split('\n')
      console.log(lines.slice(-30).join('\n'))
    }

    // Check generated server code
    const serverPath = join(SERVER_DIR, 'server.ts')
    if (existsSync(serverPath)) {
      console.log('\n=== Generated server.ts ===')
      console.log(readFileSync(serverPath, 'utf-8'))
    }

  } catch (err) {
    console.error('FATAL:', err)
  } finally {
    await mgr.stop()
    console.log(`\nDone — workspace at ${WORKSPACE} (not cleaned up for inspection)`)
  }
}

main()
