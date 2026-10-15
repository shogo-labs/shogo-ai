import { beforeEach, describe, expect, test } from 'bun:test'
import { FakeUri, fakeEditor, resetVscodeMock, state } from './vscode-mock'

const { registerCommands, CHAT_NOT_CONNECTED_MESSAGE } = await import('../commands')
const { ShogoContextOutbox } = await import('../contextOutbox')

const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)

function setup() {
  const outbox = new ShogoContextOutbox()
  let posts = 0
  let focused = 0
  const provider = {
    focus: async () => {
      focused++
    },
    postPendingReferences: async () => {
      posts++
    },
    isChatConnected: () => state.chatUrl !== 'about:blank',
  }
  registerCommands({ subscriptions: [], extensionUri: FakeUri.file('/ext') } as any, { contextOutbox: outbox } as any, provider as any)
  const run = (id: string, ...args: unknown[]) => state.commands.get(id)!(...args) as Promise<void>
  return { outbox, run, counts: () => ({ posts, focused }) }
}

beforeEach(() => resetVscodeMock())

describe('Shogo Code Add to Chat commands', () => {
  test('addSelection queues the selected ranges, opens the chat and sends them', async () => {
    const { outbox, run, counts } = setup()
    state.activeTextEditor = fakeEditor('/repo/src/big.ts', LINES, [[9, 0, 11, 7]])
    await run('shogo.context.addSelection')
    expect(outbox.pending()[0].references).toEqual([
      expect.objectContaining({ type: 'selection', path: 'src/big.ts', startLine: 10, endLine: 12 }),
    ])
    expect(counts()).toEqual({ posts: 1, focused: 1 })
    expect(state.messages.at(-1)).toBe('Added 1 item to Shogo chat.')
  })

  test('addSelection with no selection falls back to the active file', async () => {
    const { outbox, run } = setup()
    state.activeTextEditor = fakeEditor('/repo/src/big.ts', LINES, [[3, 2, 3, 2]])
    await run('shogo.context.addSelection')
    expect(outbox.pending()[0].references).toEqual([{ type: 'file', path: 'src/big.ts', name: 'big.ts' }])
  })

  test('addActiveFile outside the workspace is skipped with an explanation', async () => {
    const { outbox, run } = setup()
    state.activeTextEditor = fakeEditor('/tmp/scratch.ts', LINES, [])
    await run('shogo.context.addActiveFile')
    expect(outbox.pending()).toEqual([])
    expect(state.messages.at(-1)).toContain('skipped: scratch.ts')
  })

  test('addExplorerItems uses the Explorer multi-selection when given', async () => {
    const { outbox, run } = setup()
    state.directories.add('/repo/src')
    await run('shogo.context.addExplorerItems', FakeUri.file('/repo/a.ts'), [FakeUri.file('/repo/a.ts'), FakeUri.file('/repo/src')])
    expect(outbox.pending()[0].references.map((r) => r.path)).toEqual(['a.ts', 'src'])
    expect(state.messages.at(-1)).toBe('Added 2 items to Shogo chat.')
  })

  test('addExplorerItems falls back to the clicked item', async () => {
    const { outbox, run } = setup()
    await run('shogo.context.addExplorerItems', FakeUri.file('/repo/a.ts'))
    expect(outbox.pending()[0].references).toEqual([{ type: 'file', path: 'a.ts', name: 'a.ts' }])
  })

  test('addUris (Explorer drop) accepts URI strings', async () => {
    const { outbox, run } = setup()
    await run('shogo.context.addUris', ['file:///repo/a.ts', 'file:///repo/b.ts'])
    expect(outbox.pending()[0].references.map((r) => r.path)).toEqual(['a.ts', 'b.ts'])
  })

  test('while the chat is not connected, items stay queued and the user is told', async () => {
    const { outbox, run } = setup()
    state.chatUrl = 'about:blank'
    await run('shogo.context.addUris', ['file:///repo/a.ts'])
    expect(outbox.pending()).toHaveLength(1)
    expect(state.messages.at(-1)).toBe(CHAT_NOT_CONNECTED_MESSAGE)
  })

  test('clear empties the outbox', async () => {
    const { outbox, run } = setup()
    outbox.enqueue([{ type: 'file', path: 'a.ts', name: 'a.ts' }])
    await run('shogo.context.clear')
    expect(outbox.pending()).toEqual([])
  })
})
