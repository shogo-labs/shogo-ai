import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { HookEmitter, loadHooksFromDir } from '../hooks'
import type { HookEvent, Hook } from '../hooks'

const TEST_DIR = '/tmp/test-hooks'

describe('HookEmitter', () => {
  test('emits events to matching handlers', async () => {
    const emitter = new HookEmitter()
    const received: string[] = []

    const hooks: Hook[] = [
      {
        name: 'test-hook',
        description: 'test',
        events: ['message:received'],
        handler: async (event) => {
          received.push(`${event.type}:${event.action}`)
        },
      },
    ]

    emitter.register(hooks)
    await emitter.emit(HookEmitter.createEvent('message', 'received', 'test'))

    expect(received).toEqual(['message:received'])
  })

  test('does not call handlers for non-matching events', async () => {
    const emitter = new HookEmitter()
    let called = false

    emitter.register([
      {
        name: 'specific-hook',
        description: 'test',
        events: ['command:new'],
        handler: async () => {
          called = true
        },
      },
    ])

    await emitter.emit(HookEmitter.createEvent('message', 'received', 'test'))
    expect(called).toBe(false)
  })

  test('matches on general event type', async () => {
    const emitter = new HookEmitter()
    const received: string[] = []

    emitter.register([
      {
        name: 'general-hook',
        description: 'test',
        events: ['command'],
        handler: async (event) => {
          received.push(event.action)
        },
      },
    ])

    await emitter.emit(HookEmitter.createEvent('command', 'new', 'test'))
    await emitter.emit(HookEmitter.createEvent('command', 'reset', 'test'))

    expect(received).toEqual(['new', 'reset'])
  })

  test('matches on wildcard (*) events', async () => {
    const emitter = new HookEmitter()
    let count = 0

    emitter.register([
      {
        name: 'wildcard-hook',
        description: 'test',
        events: ['*'],
        handler: async () => {
          count++
        },
      },
    ])

    await emitter.emit(HookEmitter.createEvent('message', 'received', 'test'))
    await emitter.emit(HookEmitter.createEvent('heartbeat', 'tick', 'test'))

    expect(count).toBe(2)
  })

  test('isolates handler errors', async () => {
    const emitter = new HookEmitter()
    const received: string[] = []

    emitter.register([
      {
        name: 'failing-hook',
        description: 'test',
        events: ['message:received'],
        handler: async () => {
          throw new Error('hook failed')
        },
      },
      {
        name: 'working-hook',
        description: 'test',
        events: ['message:received'],
        handler: async () => {
          received.push('worked')
        },
      },
    ])

    await emitter.emit(HookEmitter.createEvent('message', 'received', 'test'))

    expect(received).toEqual(['worked'])
  })

  test('allows hooks to push messages', async () => {
    const emitter = new HookEmitter()

    emitter.register([
      {
        name: 'msg-hook',
        description: 'test',
        events: ['command:new'],
        handler: async (event) => {
          event.messages.push('Session saved!')
        },
      },
    ])

    const event = HookEmitter.createEvent('command', 'new', 'test')
    await emitter.emit(event)

    expect(event.messages).toEqual(['Session saved!'])
  })

  test('createEvent fills defaults', () => {
    const event = HookEmitter.createEvent('heartbeat', 'tick', 'hb-session', { foo: 'bar' })
    expect(event.type).toBe('heartbeat')
    expect(event.action).toBe('tick')
    expect(event.sessionKey).toBe('hb-session')
    expect(event.timestamp).toBeInstanceOf(Date)
    expect(event.messages).toEqual([])
    expect(event.context.foo).toBe('bar')
  })
})

describe('loadHooksFromDir', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('returns empty array for missing directory', async () => {
    const hooks = await loadHooksFromDir('/tmp/nonexistent-hooks-dir-12345')
    expect(hooks).toEqual([])
  })

  test('returns empty array for empty directory', async () => {
    const hooks = await loadHooksFromDir(TEST_DIR)
    expect(hooks).toEqual([])
  })

  test('skips directories without HOOK.md', async () => {
    mkdirSync(join(TEST_DIR, 'no-metadata'))
    writeFileSync(join(TEST_DIR, 'no-metadata', 'handler.ts'), 'export default async () => {}')
    const hooks = await loadHooksFromDir(TEST_DIR)
    expect(hooks).toEqual([])
  })

  test('skips directories without required metadata', async () => {
    mkdirSync(join(TEST_DIR, 'bad-metadata'))
    writeFileSync(
      join(TEST_DIR, 'bad-metadata', 'HOOK.md'),
      '---\ndescription: no name or events\n---\n# Bad'
    )
    writeFileSync(join(TEST_DIR, 'bad-metadata', 'handler.ts'), 'export default async () => {}')
    const hooks = await loadHooksFromDir(TEST_DIR)
    expect(hooks).toEqual([])
  })
})
