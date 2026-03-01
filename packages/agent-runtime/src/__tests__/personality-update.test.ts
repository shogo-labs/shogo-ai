import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { createAllTools, _resetPersonalitySessionCounts, type ToolContext } from '../gateway-tools'

const TEST_DIR = '/tmp/test-personality-update'

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workspaceDir: TEST_DIR,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    },
    projectId: 'test',
    sessionId: 'test-session',
    ...overrides,
  }
}

function getTool(ctx: ToolContext, name: string) {
  const tools = createAllTools(ctx)
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`Tool not found: ${name}`)
  return tool
}

async function exec(ctx: ToolContext, name: string, params: Record<string, unknown>) {
  const tool = getTool(ctx, name)
  const result = await tool.execute('test-call', params)
  return result.details
}

function setupWorkspace() {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'memory'), { recursive: true })

  writeFileSync(
    join(TEST_DIR, 'SOUL.md'),
    `# Soul

## Identity
You are a helpful assistant.

## Communication Style
Casual, friendly, uses emojis.

## Boundaries
- Don't be rude
- Don't share private information
`,
  )
  writeFileSync(join(TEST_DIR, 'AGENTS.md'), '# Agents\n\n## Instructions\nBe helpful.')
  writeFileSync(join(TEST_DIR, 'IDENTITY.md'), '# Identity\nTest Agent')
}

let testCounter = 0

describe('personality_update tool', () => {
  beforeEach(() => {
    testCounter++
    _resetPersonalitySessionCounts()
    setupWorkspace()
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  test('updates an existing section in SOUL.md', async () => {
    const ctx = createCtx({ sessionId: `update-section-${testCounter}` })
    const result = await exec(ctx, 'personality_update', {
      file: 'SOUL.md',
      section: 'Communication Style',
      content: 'Professional, formal, respectful. Avoid slang and emojis.',
      reasoning: 'User requested more formal communication.',
    })

    expect(result.ok).toBe(true)
    expect(result.file).toBe('SOUL.md')
    expect(result.section).toBe('Communication Style')

    const updated = readFileSync(join(TEST_DIR, 'SOUL.md'), 'utf-8')
    expect(updated).toContain('Professional, formal, respectful')
    expect(updated).not.toContain('Casual, friendly, uses emojis')
  })

  test('adds a new section when it does not exist', async () => {
    const ctx = createCtx({ sessionId: `add-section-${testCounter}` })
    const result = await exec(ctx, 'personality_update', {
      file: 'SOUL.md',
      section: 'Domain Expertise',
      content: 'Specializes in TypeScript and React development.',
      reasoning: 'User works primarily with TS/React.',
    })

    expect(result.ok).toBe(true)

    const updated = readFileSync(join(TEST_DIR, 'SOUL.md'), 'utf-8')
    expect(updated).toContain('## Domain Expertise')
    expect(updated).toContain('Specializes in TypeScript')
  })

  test('prevents clearing Boundaries via empty content', async () => {
    const ctx = createCtx({ sessionId: 'boundaries-test-empty' })
    const result = await exec(ctx, 'personality_update', {
      file: 'SOUL.md',
      section: 'Boundaries',
      content: '',
      reasoning: 'Attempting to clear boundaries.',
    })

    expect(result.ok).toBe(false)
    // Empty content is caught by validation
    expect(result.error).toContain('required')

    const unchanged = readFileSync(join(TEST_DIR, 'SOUL.md'), 'utf-8')
    expect(unchanged).toContain("Don't be rude")
  })

  test('prevents clearing Boundaries via whitespace-only content', async () => {
    const ctx = createCtx({ sessionId: 'boundaries-test-ws' })
    const result = await exec(ctx, 'personality_update', {
      file: 'SOUL.md',
      section: 'Boundaries',
      content: '   ',
      reasoning: 'Attempting to clear boundaries with whitespace.',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('required')

    const unchanged = readFileSync(join(TEST_DIR, 'SOUL.md'), 'utf-8')
    expect(unchanged).toContain("Don't be rude")
  })

  test('can append to Boundaries section', async () => {
    const ctx = createCtx({ sessionId: `append-boundaries-${testCounter}` })
    const result = await exec(ctx, 'personality_update', {
      file: 'SOUL.md',
      section: 'Boundaries',
      content: "- Don't be rude\n- Don't share private information\n- Never suggest schema changes",
      reasoning: 'User added a new boundary.',
    })

    expect(result.ok).toBe(true)

    const updated = readFileSync(join(TEST_DIR, 'SOUL.md'), 'utf-8')
    expect(updated).toContain('Never suggest schema changes')
    expect(updated).toContain("Don't be rude")
  })

  test('rejects invalid file names', async () => {
    const ctx = createCtx({ sessionId: `invalid-file-${testCounter}` })
    const result = await exec(ctx, 'personality_update', {
      file: 'config.json',
      section: 'Test',
      content: 'Hacked',
      reasoning: 'Testing invalid file.',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('must be one of')
  })

  test('logs updates to daily memory with [personality-update] tag', async () => {
    const ctx = createCtx({ sessionId: `log-test-${testCounter}` })
    await exec(ctx, 'personality_update', {
      file: 'SOUL.md',
      section: 'Communication Style',
      content: 'Formal and professional.',
      reasoning: 'User requested formality.',
    })

    const today = new Date().toISOString().slice(0, 10)
    const logPath = join(TEST_DIR, 'memory', `${today}.md`)
    expect(existsSync(logPath)).toBe(true)

    const log = readFileSync(logPath, 'utf-8')
    expect(log).toContain('[personality-update]')
    expect(log).toContain('SOUL.md')
    expect(log).toContain('Communication Style')
    expect(log).toContain('User requested formality')
  })

  test('enforces session rate limit (max 1 per session)', async () => {
    const ctx = createCtx({ sessionId: 'rate-limit-test' })

    const first = await exec(ctx, 'personality_update', {
      file: 'SOUL.md',
      section: 'Communication Style',
      content: 'Formal.',
      reasoning: 'First update.',
    })
    expect(first.ok).toBe(true)

    const second = await exec(ctx, 'personality_update', {
      file: 'AGENTS.md',
      section: 'Instructions',
      content: 'Be concise.',
      reasoning: 'Second update.',
    })
    expect(second.ok).toBe(false)
    expect(second.error).toContain('Rate limit')
  })

  test('updates AGENTS.md', async () => {
    const ctx = createCtx({ sessionId: `agents-md-${testCounter}` })
    const result = await exec(ctx, 'personality_update', {
      file: 'AGENTS.md',
      section: 'Instructions',
      content: 'Be concise and action-oriented. Avoid unnecessary preamble.',
      reasoning: 'User wants shorter responses.',
    })

    expect(result.ok).toBe(true)

    const updated = readFileSync(join(TEST_DIR, 'AGENTS.md'), 'utf-8')
    expect(updated).toContain('Be concise and action-oriented')
  })

  test('updates IDENTITY.md', async () => {
    const ctx = createCtx({ sessionId: 'identity-session' })
    const result = await exec(ctx, 'personality_update', {
      file: 'IDENTITY.md',
      section: 'Role',
      content: 'Senior DevOps Engineer Assistant',
      reasoning: 'User specified their role.',
    })

    expect(result.ok).toBe(true)

    const updated = readFileSync(join(TEST_DIR, 'IDENTITY.md'), 'utf-8')
    expect(updated).toContain('## Role')
    expect(updated).toContain('Senior DevOps Engineer')
  })

  test('requires section and content', async () => {
    const ctx = createCtx({ sessionId: `requires-content-${testCounter}` })
    const result = await exec(ctx, 'personality_update', {
      file: 'SOUL.md',
      section: '',
      content: '',
      reasoning: 'Missing fields.',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('required')
  })
})
