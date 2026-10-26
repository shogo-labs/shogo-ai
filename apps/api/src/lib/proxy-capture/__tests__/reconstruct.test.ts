import { describe, expect, test } from 'bun:test'
import { chainRequest, stableStringify } from '../chain'
import { reconstructRequest } from '../reconstruct'

function loader(objects: Map<string, unknown>) {
  return async (key: string): Promise<unknown> => objects.get(key)
}

function capture(messages: unknown[], stream: Map<string, unknown>, workspaceId = 'workspace-1') {
  const chained = chainRequest({ model: 'claude-sonnet-4-5', messages }, workspaceId, async (key, body) => {
    stream.set(key, body)
  })
  return chained.request
}

function conversation(length: number): unknown[] {
  return Array.from({ length }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `step ${index}` }],
  }))
}

describe('archive reconstruction', () => {
  test('passes a v1 request through and resolves $ref blobs', async () => {
    const objects = new Map<string, unknown>([['v1/blobs/system.json.gz', 'You are helpful.']])
    const request = {
      system: { $ref: 'v1/blobs/system.json.gz', kind: 'system' },
      messages: [{ role: 'user', content: 'hi' }],
    }
    const rebuilt = await reconstructRequest({ id: 'record-1', request }, loader(objects)) as any

    expect(rebuilt.system).toBe('You are helpful.')
    expect(rebuilt.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  test('walks chat, anthropic and responses chains back to the original request', async () => {
    const objects = new Map<string, unknown>()
    const messages = conversation(45)
    const chat = capture(messages, objects)
    expect((chat as any).chain).toBeDefined()
    expect(stableStringify(await reconstructRequest(chat, loader(objects)))).toBe(stableStringify({ model: 'claude-sonnet-4-5', messages }))

    const anthropic = {
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: 'be brief' }],
      messages: conversation(31),
    }
    const anthropicChained = chainRequest(anthropic, 'workspace-1', async (key, body) => {
      objects.set(key, body)
    }).request
    expect(stableStringify(await reconstructRequest(anthropicChained, loader(objects)))).toBe(stableStringify(anthropic))

    const input = { model: 'gpt-5', input: conversation(30) }
    const inputChained = chainRequest(input, 'workspace-1', async (key, body) => {
      objects.set(key, body)
    }).request
    expect((inputChained as any).chain.list).toBe('input')
    expect(stableStringify(await reconstructRequest(inputChained, loader(objects)))).toBe(stableStringify(input))

    const stringInput = await reconstructRequest({ model: 'gpt-5', input: 'what changed?' }, loader(objects)) as any
    expect(stringInput.input).toBe('what changed?')
  })

  test('resolves $ref inside chained nodes and keeps $media placeholders', async () => {
    const objects = new Map<string, unknown>([['v1/blobs/system.json.gz', [{ type: 'text', text: 'rules' }]]])
    const messages = [
      { role: 'system', content: { $ref: 'v1/blobs/system.json.gz', kind: 'system' } },
      { role: 'user', content: [{ type: 'image_url', image_url: { $media: 'hash-1', mime: 'image/png' } }] },
      ...conversation(24),
    ]
    const chained = capture(messages, objects)
    const rebuilt = await reconstructRequest(chained, loader(objects)) as any

    expect(rebuilt.messages[0].content).toEqual([{ type: 'text', text: 'rules' }])
    expect(rebuilt.messages[1].content[0].image_url).toEqual({ $media: 'hash-1', mime: 'image/png' })
    expect(rebuilt.messages).toHaveLength(messages.length)
  })

  test('fails loudly when a node object is missing', async () => {
    const objects = new Map<string, unknown>()
    const chained = capture(conversation(30), objects)
    objects.clear()
    await expect(reconstructRequest(chained, loader(objects))).rejects.toThrow(/chain node .* is missing or malformed/)
  })

  test('fails loudly on a parent cycle instead of looping forever', async () => {
    const objects = new Map<string, unknown>([
      ['v2/chain/workspace-1/a.json.gz', { parent: 'v2/chain/workspace-1/b.json.gz', append: [] }],
      ['v2/chain/workspace-1/b.json.gz', { parent: 'v2/chain/workspace-1/a.json.gz', append: [] }],
    ])
    const record = { request: { chain: { head: 'v2/chain/workspace-1/a.json.gz', tail: [], list: 'messages' } } }
    await expect(reconstructRequest(record, loader(objects))).rejects.toThrow(/chain cycle/)
  })
})
