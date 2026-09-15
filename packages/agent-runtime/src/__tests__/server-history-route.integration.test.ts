import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const integration = process.env.RUN_INTEGRATION === '1'

describe.skipIf(!integration)('runtime history HTTP integration', () => {
  test('serves /agent/history/search from the real server app', async () => {
    const workspace = mkdtempSync(join('/tmp', 'shogo-server-history-'))
    try {
      process.env.WORKSPACE_DIR = workspace
      mkdirSync(join(workspace, '.shogo', 'plans'), { recursive: true })
      const db = new Database(join(workspace, '.shogo', 'sessions.db'))
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)')
      db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
        'history-chat',
        JSON.stringify({ id: 'history-chat', messages: [{ role: 'user', content: 'Find the workspace history' }] }),
        1,
      )
      db.close()
      await Bun.write(join(workspace, '.shogo/plans/history.plan.md'), '---\nname: History plan\n---\nWorkspace history')

      const server = (await import('../server')).default
      const response = await server.fetch(
        new Request('http://runtime.test/agent/history/search?q=workspace'),
        {} as any,
      )
      expect(response.status).toBe(200)
      expect((await response.json()).results.length).toBeGreaterThan(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      delete process.env.WORKSPACE_DIR
    }
  })
})
