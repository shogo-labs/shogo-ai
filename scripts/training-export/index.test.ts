import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { normalizeCapture } from '../../apps/api/src/lib/proxy-capture/normalize'
import { readArchiveFiles, selectExamples, scrubText, toTrainingExample } from './index'

const ROOT = resolve(`.tmp/training-export-parity-${process.pid}`)

async function writeFixture(dir: string, format: 'v1' | 'v2'): Promise<void> {
  const blobs = new Map<string, unknown>()
  const nodes = new Map<string, unknown>()
  const writeBlob = (key: string, value: unknown): void => { blobs.set(key, value) }
  const writeNode = async (key: string, body: any): Promise<void> => { nodes.set(key, body) }

  const lines: string[] = []
  for (let turn = 0; turn < 3; turn += 1) {
    const messages = [
      { role: 'system', content: `You are agent ${turn}.` },
      { role: 'user', content: `turn ${turn}: find the release notes` },
    ]
    for (let step = 0; step < 12; step += 1) {
      messages.push(
        { role: 'assistant', content: `step ${step}: searching ${'detail '.repeat(40)}` } as any,
        { role: 'user', content: `result ${step}: ${'row '.repeat(40)}` } as any,
      )
    }
    const capture = normalizeCapture(
      {
        authKind: 'runtime',
        workspaceId: 'workspace-1',
        chatSessionId: `session-${turn}`,
        endpoint: 'chat.completions',
        requestedModel: 'claude-sonnet-4-5',
        resolvedModel: 'claude-sonnet-4-5',
        provider: 'anthropic',
      },
      {
        model: 'claude-sonnet-4-5',
        system: [{ type: 'text', text: 'You are helpful.' }],
        tools: [{ type: 'function', name: 'search' }],
        messages,
      },
      { content: `answer ${turn}` },
      writeBlob,
      format === 'v2' ? writeNode : undefined,
    )
    await Promise.all(capture.chainWrites)
    lines.push(JSON.stringify({
      id: `record-${turn}`,
      ts: new Date(Date.UTC(2026, 9, 21, 9, turn)).toISOString(),
      source: 'cloud_runtime',
      workspaceId: 'workspace-1',
      provider: 'anthropic',
      resolvedModel: 'claude-sonnet-4-5',
      turnKey: createHash('sha256').update(`turn-${turn}`).digest('hex'),
      request: format === 'v2' ? capture.request : capture.requestInline,
      response: capture.response,
    }))
  }

  const root = resolve(dir)
  for (const [key, value] of [...blobs, ...nodes]) {
    await mkdir(dirname(join(root, key)), { recursive: true })
    await Bun.write(join(root, key), gzipSync(Buffer.from(JSON.stringify(value))))
  }
  const batch = `${format}/region=test/date=2026-10-21/hour=09/batch.jsonl.gz`
  await mkdir(dirname(join(root, batch)), { recursive: true })
  await Bun.write(join(root, batch), gzipSync(Buffer.from(`${lines.join('\n')}\n`)))
}

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe('training export v1/v2 parity', () => {
  test('a v1 and a v2 archive of the same traffic export the same examples', async () => {
    await writeFixture(join(ROOT, 'v1'), 'v1')
    await writeFixture(join(ROOT, 'v2'), 'v2')

    const legacy = await readArchiveFiles(join(ROOT, 'v1'))
    const chained = await readArchiveFiles(join(ROOT, 'v2'))
    expect(legacy.records).toHaveLength(3)
    expect(chained.records).toHaveLength(3)
    expect((chained.records[0]!.request as any).chain).toBeDefined()
    expect((legacy.records[0]!.request as any).messages).toBeDefined()

    const fromV1 = await selectExamples(legacy)
    const fromV2 = await selectExamples(chained)
    expect(fromV1).toHaveLength(3)
    expect(JSON.stringify(fromV2)).toBe(JSON.stringify(fromV1))
    expect(fromV2[0]!.messages).toHaveLength(28)
  })
})

describe('training export normalization', () => {
  test('resolves deduplicated tools and preserves tool calls/results', () => {
    const example = toTrainingExample(
      {
        id: 'capture-1',
        ts: '2026-09-26T05:00:00.000Z',
        workspaceId: 'workspace-1',
        turnKey: 'turn-1',
        source: 'desktop_proxy',
        resolvedModel: 'claude-sonnet',
        request: {
          system: { $ref: 'v1/blobs/system.json.gz', kind: 'system' },
          tools: { $ref: 'v1/blobs/tools.json.gz', kind: 'tools' },
          messages: [
            { role: 'user', content: 'Search the docs' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'search', input: { q: 'docs' } }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Found it' }] },
          ],
        },
        response: {
          content: 'The docs are here.',
          tool_calls: [],
        },
      },
      { feedback: 'up', revertedAt: null, hadError: false, truncated: false },
      new Map([
        ['v1/blobs/system.json.gz', [{ type: 'text', text: 'You are helpful.' }]],
        ['v1/blobs/tools.json.gz', [{ type: 'function', name: 'search' }]],
      ]),
    )

    expect(example).not.toBeNull()
    expect(example!.tools).toEqual([{ type: 'function', name: 'search' }])
    expect(example!.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(example!.signals.feedback).toBe('up')
  })

  test('rejects secrets and scrubs PII in text', () => {
    expect(toTrainingExample({
      id: 'capture-2',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-2',
      request: { messages: [{ role: 'user', content: 'token: sk-test-123456789012345678901234' }] },
      response: { content: 'ok' },
    })).toBeNull()

    expect(scrubText('Contact me at person@example.com or 415-555-1212').value)
      .toBe('Contact me at [REDACTED_PII] or [REDACTED_PII]')
  })

  test('exports media references as dataset assets', () => {
    const example = toTrainingExample({
      id: 'capture-3',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-3',
      request: {
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: { $media: 'image-hash', mime: 'image/png' } } }],
        }],
      },
      response: { content: 'I see an image.' },
    })

    expect(example?.media).toEqual([{
      hash: 'image-hash',
      mime: 'image/png',
      path: 'media/image-hash',
    }])
  })

  test('normalizes Responses reasoning items and function calls', () => {
    const example = toTrainingExample({
      id: 'capture-4',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-4',
      request: { input: [{ role: 'user', content: 'Call the search tool' }] },
      response: {
        output: [
          { type: 'reasoning', id: 'reason-1', summary: [{ type: 'summary_text', text: 'I should search.' }] },
          { type: 'function_call', call_id: 'call-3', name: 'search', arguments: '{"q":"docs"}' },
        ],
      },
    })

    expect(example?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      reasoning_content: 'I should search.',
      tool_calls: [{
        id: 'call-3',
        function: { name: 'search', arguments: '{"q":"docs"}' },
      }],
    })
  })

  test('normalizes a Claude assistant content block response', () => {
    const example = toTrainingExample({
      id: 'capture-5',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-5',
      request: { messages: [{ role: 'user', content: 'Explain the result' }] },
      response: {
        content: [
          { type: 'thinking', thinking: 'I should be concise.' },
          { type: 'text', text: 'The result is ready.' },
          { type: 'tool_use', id: 'call-5', name: 'search', input: { q: 'result' } },
        ],
      },
    })

    expect(example?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'The result is ready.',
      reasoning_content: 'I should be concise.',
      tool_calls: [{
        id: 'call-5',
        function: { name: 'search', arguments: '{"q":"result"}' },
      }],
    })
  })

  test('normalizes a non-streaming chat.completions response and drops empty completions', () => {
    const record = (message: Record<string, unknown>) => ({
      id: 'capture-7',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-7',
      request: { messages: [{ role: 'user', content: 'Weather in Paris?' }] },
      response: { id: 'chatcmpl-1', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }] },
    })

    expect(toTrainingExample(record({ content: 'Sunny.' }))?.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Sunny.' })
    expect(toTrainingExample(record({
      content: null,
      tool_calls: [{ id: 'call-7', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' } }],
    }))?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call-7', function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' } }],
    })
    expect(toTrainingExample(record({ content: null }))).toBeNull()
  })

  test('normalizes a Responses API request with string input and instructions', () => {
    const example = toTrainingExample(
      {
        id: 'capture-8',
        ts: '2026-09-26T05:00:00.000Z',
        workspaceId: 'workspace-1',
        turnKey: 'turn-8',
        request: { instructions: { $ref: 'v1/blobs/instructions.json.gz', kind: 'system' }, input: 'What changed?' },
        response: { content: 'Two files.' },
      },
      undefined,
      new Map([['v1/blobs/instructions.json.gz', 'Be brief.']]),
    )

    expect(example?.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What changed?' },
      { role: 'assistant', content: 'Two files.' },
    ])
  })

  test('drops examples whose tool-call arguments are not a JSON object', () => {
    const record = (args: string) => ({
      id: 'capture-6',
      ts: '2026-09-26T05:00:00.000Z',
      workspaceId: 'workspace-1',
      turnKey: 'turn-6',
      request: { messages: [{ role: 'user', content: 'Weather in Paris?' }] },
      response: { tool_calls: [{ id: 'call-6', name: 'lookup_weather', arguments: args }] },
    })

    expect(toTrainingExample(record('{}{"city":"Paris"}'))).toBeNull()
    expect(toTrainingExample(record('{"city":'))).toBeNull()
    expect(toTrainingExample(record('{"city":"Paris"}'))).not.toBeNull()
  })
})
