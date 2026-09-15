import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryIndex } from '../packages/agent-runtime/src/history-index'

const roots: string[] = []
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

function projectFixture(name: string, message: string) {
  const root = mkdtempSync(join(tmpdir(), `shogo-e2e-${name}-`))
  roots.push(root)
  mkdirSync(join(root, '.shogo', 'plans'), { recursive: true })
  const db = new Database(join(root, '.shogo', 'sessions.db'))
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
    `${name}-chat`,
    JSON.stringify({ id: `${name}-chat`, messages: [{ role: 'user', content: message }] }),
    1,
  )
  db.close()
  writeFileSync(join(root, `.shogo/plans/${name}.plan.md`), `---\nname: ${name} Plan\nstatus: active\n---\n${message}`)
  return root
}

describe('history search e2e fixtures', () => {
  test('finds pinned/home-style chats and plans across project fixtures', () => {
    const app = projectFixture('app', 'Implement workspace history search')
    const home = projectFixture('home', 'Review the billing dashboard')
    const appIndex = new HistoryIndex(app)
    const homeIndex = new HistoryIndex(home)

    expect(appIndex.search('workspace history', { kind: 'chat' })[0]?.id).toBe('app-chat')
    expect(appIndex.search('app plan', { kind: 'plan' })[0]?.id).toBe('app.plan.md')
    expect(homeIndex.search('billing', { kind: 'chat' })[0]?.id).toBe('home-chat')
    expect(appIndex.search('billing')).toHaveLength(0)

    appIndex.close()
    homeIndex.close()
  })
})
