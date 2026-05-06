// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Quick-look helper: list every Composio connection registered against
 * the local-mode demo user under BOTH the workspace-scoped and the
 * project-scoped Composio user IDs. Used to figure out which toolkits
 * still need OAuth before re-recording demo scenes 6/7/8.
 *
 * Usage:
 *   bun scripts/list-composio-connections.ts [workspaceId]
 *
 * Requires COMPOSIO_API_KEY in the environment (already set in
 * .env.local).
 */

import { Composio } from '@composio/core'

function loadDotEnv() {
  // bun runs without auto-loading .env.local for ad-hoc scripts.
  // We deliberately don't use bun --env-file=… because that flag is
  // only on bun >=1.2; using readline keeps the script portable.
  const fs = require('node:fs') as typeof import('node:fs')
  // Walk a couple of plausible locations so this works whether you
  // run it from the repo root or from inside packages/agent-runtime.
  const candidates = [
    '.env.local',
    '.env',
    '../../.env.local',
    '../../.env',
  ]
  for (const path of candidates) {
    if (!fs.existsSync(path)) continue
    const text = fs.readFileSync(path, 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
      if (!m) continue
      const key = m[1]
      let value = m[2]
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
}

async function main() {
  loadDotEnv()
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) {
    console.error('COMPOSIO_API_KEY not set. Aborting.')
    process.exit(1)
  }

  const workspaceId = process.argv[2] ?? '88394851-8209-4001-b09c-2b897a7cd193'
  const userId = 'b691c18e-f1a3-4701-9915-9d45fd69c4d2' // local@shogo.local

  const wsScopedId = `shogo_${userId}_${workspaceId}`
  console.log(`Looking up Composio connections for:`)
  console.log(`  user        : ${userId} (local@shogo.local)`)
  console.log(`  workspace   : ${workspaceId}`)
  console.log(`  ws-scoped id: ${wsScopedId}\n`)

  const composio = new Composio({ apiKey })
  const list = await composio.connectedAccounts.list({ userIds: [wsScopedId] })
  const items: any[] = (list as any).items ?? (list as any).data ?? []

  if (items.length === 0) {
    console.log(`No connections found at workspace scope.\n`)
  } else {
    console.log(`Workspace-scoped connections (${items.length}):`)
    for (const acc of items) {
      const tk = acc.toolkit?.slug ?? acc.appName ?? '?'
      console.log(`  - ${tk.padEnd(20)} status=${acc.status} id=${acc.id}`)
    }
    console.log()
  }

  // Also list every connection for any *project-scoped* userId in this
  // workspace, so we can see what was OAuth'd under the old format.
  // We can't list those without enumerating every project — instead
  // grab every project, build the project-scoped id, and check.
  const { Database } = await import('bun:sqlite')
  const dbPath = process.env.SHOGO_DEV_DB ?? '../../shogo.db'
  const db = new Database(dbPath)
  const projects = db.prepare(
    `SELECT id, name FROM projects WHERE workspaceId = ? ORDER BY createdAt DESC LIMIT 20`,
  ).all(workspaceId) as Array<{ id: string; name: string }>

  for (const p of projects) {
    const projScopedId = `shogo_${userId}_${workspaceId}_${p.id}`
    const r = await composio.connectedAccounts.list({ userIds: [projScopedId] })
    const ri: any[] = (r as any).items ?? (r as any).data ?? []
    if (ri.length === 0) continue
    console.log(`Project ${p.name} (${p.id}) project-scoped:`)
    for (const acc of ri) {
      const tk = acc.toolkit?.slug ?? acc.appName ?? '?'
      console.log(`  - ${tk.padEnd(20)} status=${acc.status} id=${acc.id}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
