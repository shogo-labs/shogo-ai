// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A turn killed mid-text used to leave the transcript with nothing but the
 * person's prompt: messages are written at a tool boundary or at turn end, so a
 * single model call that never finished wrote nothing. The streamed text now
 * rides in the in-flight marker and the boot sweep puts it back as an assistant
 * message ending in `[interrupted here]`, so the resume continues rather than
 * starting over (SHO-274).
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AssistantMessage, Message } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { buildTextResponse } from '../pi-adapter'
import { clearSessionTodos } from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'
import { SqliteSessionPersistence } from '../sqlite-session-persistence'
import {
  INFLIGHT_PARTIAL_MAX_CHARS,
  SessionManager,
  capInflightPartial,
  normalizeInflightTurn,
  type SerializedSession,
  type SessionPersistence,
} from '../session-manager'
import { INTERRUPTED_TURN_PARTIAL_MARKER } from '@shogo/shared-runtime/interrupted-turn'

/** A persistence double that records saves and can fail a set number of them. */
function fakePersistence(options: { failFirst?: number } = {}) {
  const saved: Array<{ id: string; session: SerializedSession }> = []
  let failures = options.failFirst ?? 0
  const persistence: SessionPersistence = {
    async save(id, session) {
      if (failures > 0) {
        failures -= 1
        throw new Error('SQLITE_BUSY: database is locked')
      }
      saved.push({ id, session: JSON.parse(JSON.stringify(session)) })
    },
    async load() {
      return null
    },
    async delete() {},
    async loadAll() {
      return []
    },
  }
  return { persistence, saved }
}

const textOf = (message: Message): string => {
  const content = (message as any).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block?.type === 'text')
    .map((block: any) => block.text)
    .join('')
}

describe('the in-flight marker carries the streamed partial (SHO-274)', () => {
  test('a partial survives normalization and is trimmed to its tail', () => {
    const marker = normalizeInflightTurn({
      startedAt: 1_000,
      partialText: 'Half a reply',
      partialReasoning: 'Thinking about it',
    })
    expect(marker?.partialText).toBe('Half a reply')
    expect(marker?.partialReasoning).toBe('Thinking about it')
  })

  test('an oversized partial keeps its tail, not its head', () => {
    const long = 'x'.repeat(INFLIGHT_PARTIAL_MAX_CHARS + 500) + 'END'
    const marker = normalizeInflightTurn({ startedAt: 1_000, partialText: long })
    expect(marker?.partialText?.length).toBe(INFLIGHT_PARTIAL_MAX_CHARS)
    expect(marker?.partialText?.endsWith('END')).toBe(true)
    expect(capInflightPartial(long)?.endsWith('END')).toBe(true)
  })

  test('empty partials are absent rather than empty strings', () => {
    const marker = normalizeInflightTurn({ startedAt: 1_000, partialText: '', partialReasoning: '' })
    expect(marker).not.toBeNull()
    expect('partialText' in (marker as object)).toBe(false)
    expect('partialReasoning' in (marker as object)).toBe(false)
    expect(capInflightPartial(undefined)).toBeUndefined()
    expect(capInflightPartial('')).toBeUndefined()
  })
})

describe('appendInterruptedPartial (SHO-274)', () => {
  let manager: SessionManager
  let saved: Array<{ id: string; session: SerializedSession }>

  beforeEach(() => {
    manager = new SessionManager({ pruneIntervalSeconds: 999 })
    const double = fakePersistence()
    saved = double.saved
    manager.setPersistence(double.persistence)
  })

  test('appends the streamed text as a closed assistant message', () => {
    manager.addMessages('chat-partial', { role: 'user', content: 'Write the migration', timestamp: 1 } as Message)

    const added = manager.appendInterruptedPartial('chat-partial', 'Starting with the schema…')

    expect(added).toBe(true)
    const messages = manager.get('chat-partial')!.messages
    expect(messages).toHaveLength(2)
    const tail = messages.at(-1) as AssistantMessage
    expect(tail.role).toBe('assistant')
    expect(textOf(tail)).toBe(`Starting with the schema…\n\n${INTERRUPTED_TURN_PARTIAL_MARKER}`)
    // A finished message, so nothing downstream re-reads it as mid-stream.
    expect(tail.stopReason).toBe('stop')
  })

  test('runs once per death: a second call adds nothing', () => {
    manager.addMessages('chat-partial', { role: 'user', content: 'Write the migration', timestamp: 1 } as Message)

    expect(manager.appendInterruptedPartial('chat-partial', 'Starting with the schema…')).toBe(true)
    expect(manager.appendInterruptedPartial('chat-partial', 'Starting with the schema…')).toBe(false)
    expect(manager.get('chat-partial')!.messages).toHaveLength(2)
  })

  test('a step that was already persisted is not written twice', () => {
    // The tool-boundary write landed before the crash, so the tail already holds
    // this text; the marker must not append a copy of it.
    manager.addMessages(
      'chat-partial',
      { role: 'user', content: 'Write the migration', timestamp: 1 } as Message,
      { role: 'assistant', content: 'Starting with the schema…', timestamp: 2 } as unknown as Message,
    )

    expect(manager.appendInterruptedPartial('chat-partial', 'Starting with the schema…')).toBe(false)
    expect(manager.get('chat-partial')!.messages).toHaveLength(2)
  })

  test('nothing to restore is a no-op, and an unknown session is not created', () => {
    manager.addMessages('chat-partial', { role: 'user', content: 'hi', timestamp: 1 } as Message)
    expect(manager.appendInterruptedPartial('chat-partial', '   ')).toBe(false)
    expect(manager.appendInterruptedPartial('chat-missing', 'text')).toBe(false)
    expect(manager.get('chat-missing')).toBeUndefined()
  })

  test('the restored message is persisted immediately', async () => {
    manager.addMessages('chat-partial', { role: 'user', content: 'Write the migration', timestamp: 1 } as Message)
    manager.appendInterruptedPartial('chat-partial', 'Starting with the schema…')
    await manager.flushPendingSaves()

    const last = saved.at(-1)!
    expect(last.id).toBe('chat-partial')
    expect(textOf(last.session.messages.at(-1) as Message)).toContain(INTERRUPTED_TURN_PARTIAL_MARKER)
  })
})

describe('persistSession durability (SHO-274)', () => {
  test('a transient save failure is retried instead of losing the session', async () => {
    const manager = new SessionManager({ pruneIntervalSeconds: 999 })
    const double = fakePersistence({ failFirst: 1 })
    manager.setPersistence(double.persistence)

    manager.addMessages('chat-save', { role: 'user', content: 'Remember this', timestamp: 1 } as Message)
    await manager.flushPendingSaves()

    expect(double.saved).toHaveLength(1)
    expect(double.saved[0]!.session.messages).toHaveLength(1)
  })

  test('flushPendingSaves waits for in-flight writes and reports how many', async () => {
    const manager = new SessionManager({ pruneIntervalSeconds: 999 })
    const written: string[] = []
    manager.setPersistence({
      async save(id) {
        await new Promise((resolve) => setTimeout(resolve, 30))
        written.push(id)
      },
      async load() {
        return null
      },
      async delete() {},
      async loadAll() {
        return []
      },
    })

    manager.addMessages('chat-a', { role: 'user', content: 'one', timestamp: 1 } as Message)
    manager.addMessages('chat-b', { role: 'user', content: 'two', timestamp: 1 } as Message)

    const drained = await manager.flushPendingSaves(2_000)

    expect(drained).toBeGreaterThan(0)
    expect(written.sort()).toEqual(['chat-a', 'chat-b'])
  })

  test('flushPendingSaves returns 0 when nothing is in flight', async () => {
    const manager = new SessionManager({ pruneIntervalSeconds: 999 })
    manager.setPersistence(fakePersistence().persistence)
    expect(await manager.flushPendingSaves()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Boot sweep: the transcript gets the partial back before the resume runs
// ---------------------------------------------------------------------------

let testCounter = 0
const makeTestDir = () => join(tmpdir(), `test-partial-reply-${process.pid}-${++testCounter}`)

function setupWorkspace(dir: string) {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })
  mkdirSync(join(dir, '.shogo'), { recursive: true })
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    }),
  )
  writeFileSync(join(dir, 'AGENTS.md'), '# Agent\nYou are a test agent.')
}

const SESSION_ID = 'chat-partial-reply'
const PARTIAL = 'Reading the migration files. The first one adds an index'

/** What a text-only turn killed mid-reply leaves: the prompt persisted, no reply. */
const promptOnlyMessages = (): Message[] =>
  [{ role: 'user', content: 'Add an index to the sessions table', timestamp: 1 }] as unknown as Message[]

describe('a turn killed mid-text resumes from what was streamed (SHO-274)', () => {
  let testDir: string
  let gateway: AgentGateway | undefined
  const previous = {
    resume: process.env.AGENT_RESUME_MAX_AGE_MINUTES,
    plan: process.env.AGENT_MAX_PLAN_CONTINUATIONS,
  }

  beforeEach(() => {
    testDir = makeTestDir()
    setupWorkspace(testDir)
    trustWorkspaceForTests(testDir)
    delete process.env.AGENT_RESUME_MAX_AGE_MINUTES
    process.env.AGENT_MAX_PLAN_CONTINUATIONS = '0'
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    gateway = undefined
    clearTrustForTests()
    clearSessionTodos(SESSION_ID)
    rmSync(testDir, { recursive: true, force: true })
    for (const [key, value] of [
      ['AGENT_RESUME_MAX_AGE_MINUTES', previous.resume],
      ['AGENT_MAX_PLAN_CONTINUATIONS', previous.plan],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  async function seedInterrupted(marker: Record<string, any>) {
    const persistence = new SqliteSessionPersistence(testDir)
    const messages = promptOnlyMessages()
    await persistence.save(SESSION_ID, {
      id: SESSION_ID,
      messages,
      compactedSummary: null,
      createdAt: Date.now() - 60_000,
      lastActivityAt: Date.now() - 60_000,
      totalMessages: messages.length,
      compactionCount: 0,
      metadata: { inflightTurn: { id: 'turn-1', startedAt: Date.now() - 30_000, resumeAttempts: 0, ...marker } },
    })
  }

  async function storedSession(): Promise<SerializedSession | null> {
    return new SqliteSessionPersistence(testDir).load(SESSION_ID)
  }

  /** A stream that records the whole context the resumed model is given. */
  function recordingStream(seen: Message[][]): StreamFn {
    return ((_model: any, context: any) => {
      seen.push([...context.messages])
      const message: AssistantMessage = buildTextResponse('Continuing from where it stopped.')
      const stream = createAssistantMessageEventStream()
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'done', reason: 'stop', message })
        stream.end(message)
      })
      return stream as any
    }) as StreamFn
  }

  async function waitForAnswer(): Promise<void> {
    const answered = () =>
      !!gateway
        ?.getSessionManager()
        .get(SESSION_ID)
        ?.messages.some((m) => m.role === 'assistant' && textOf(m).includes('Continuing from where it stopped'))
    const deadline = Date.now() + 5_000
    while (!answered() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  test('the streamed text is in the transcript the resumed turn reads', async () => {
    await seedInterrupted({ partialText: PARTIAL })

    const seen: Message[][] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(recordingStream(seen))
    await gateway.start()
    await waitForAnswer()

    const inMemory = gateway.getSessionManager().get(SESSION_ID)!.messages
    const restored = inMemory.filter((m) => m.role === 'assistant' && textOf(m).includes('The first one adds an index'))
    expect(restored).toHaveLength(1)
    expect(textOf(restored[0]!)).toBe(`${PARTIAL}\n\n${INTERRUPTED_TURN_PARTIAL_MARKER}`)
    // It sits after the prompt, so the resumed model reads prompt → partial → ask.
    const promptIndex = inMemory.findIndex((m) => textOf(m).includes('Add an index to the sessions table'))
    expect(promptIndex).toBeLessThan(inMemory.indexOf(restored[0]!))

    // The model call itself saw it: the resume is a continuation, not a restart.
    expect(seen).toHaveLength(1)
    const assistantSeen = seen[0]!.filter((m) => m.role === 'assistant' && textOf(m).includes('The first one adds an index'))
    expect(assistantSeen).toHaveLength(1)

    // And it reached disk, so a second crash cannot lose it again.
    await gateway.stop()
    gateway = undefined
    const stored = await storedSession()
    expect(JSON.stringify(stored?.messages ?? [])).toContain('The first one adds an index')
  })

  test('a turn with no streamed text is recovered exactly as before', async () => {
    // Died before the first delta: nothing to restore, and no stray marker row.
    await seedInterrupted({})

    const seen: Message[][] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(recordingStream(seen))
    await gateway.start()
    await waitForAnswer()

    const inMemory = gateway.getSessionManager().get(SESSION_ID)!.messages
    expect(inMemory.some((m) => textOf(m).includes(INTERRUPTED_TURN_PARTIAL_MARKER))).toBe(false)
    expect(seen).toHaveLength(1)
  })
})
