import { describe, expect, test } from 'bun:test'
import { buildChain, chainRequest, stableStringify } from '../chain'

function conversation(length: number): Array<Record<string, unknown>> {
  return Array.from({ length }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: [{ type: 'text', text: `message ${index} ${'context '.repeat(index % 5)}` }],
  }))
}

function collect(): { write: (key: string, body: any) => Promise<void>; nodes: Map<string, any> } {
  const nodes = new Map<string, any>()
  return {
    nodes,
    write: async (key, body) => {
      nodes.set(key, body)
    },
  }
}

describe('content-defined chain', () => {
  test('reproduces the same boundaries from the same content', () => {
    const messages = conversation(40)
    const first = buildChain('workspace-1', messages)
    const second = buildChain('workspace-1', [...messages])

    expect(first.writes.map((node) => node.key)).toEqual(second.writes.map((node) => node.key))
    expect(first.head).toBe(second.head)
    expect(stableStringify(first.tail)).toBe(stableStringify(second.tail))
  })

  test('never addresses a node from two workspaces, even for identical conversations', () => {
    const messages = conversation(40)
    const one = buildChain('workspace-1', messages)
    const two = buildChain('workspace-2', messages)

    expect(one.writes.length).toBeGreaterThan(0)
    expect(two.writes.length).toBeGreaterThan(0)
    expect(one.writes.some((node) => node.key.includes('/workspace-1/'))).toBe(true)
    expect(two.writes.some((node) => node.key.includes('/workspace-2/'))).toBe(true)
    const overlap = one.writes.filter((node) => two.writes.some((other) => other.key === node.key))
    expect(overlap).toEqual([])
  })

  test('nodes plus the inline tail reassemble the exact list', () => {
    const messages = conversation(37)
    const chain = buildChain('workspace-1', messages)
    const fromNodes = chain.writes.flatMap((node) => node.body.append)

    expect(stableStringify([...fromNodes, ...chain.tail])).toBe(stableStringify(messages))
    expect(chain.tail.length).toBeLessThan(20)
  })

  test('each node points at the previous node and only appends after it', () => {
    const chain = buildChain('workspace-1', conversation(40))
    expect(chain.writes[0]!.body.parent).toBeNull()
    for (let index = 1; index < chain.writes.length; index += 1) {
      expect(chain.writes[index]!.body.parent).toBe(chain.writes[index - 1]!.key)
    }
    expect(chain.head).toBe(chain.writes.at(-1)!.key)
  })

  test('a rewritten history diverges at the first changed message', () => {
    const messages = conversation(40)
    const original = buildChain('workspace-1', messages)
    const rewritten = [...messages]
    rewritten[20] = { role: 'assistant', content: 'compact summary of the first twenty messages' }
    const compacted = buildChain('workspace-1', rewritten)

    const shared = original.writes.filter((node) => compacted.writes.some((other) => other.key === node.key))
    expect(shared.length).toBeGreaterThan(0)
    expect(shared.some((node) => node.body.append.some((message) => stableStringify(message).includes('compact summary')))).toBe(false)
    const rebuilt = compacted.writes.flatMap((node) => node.body.append)
    expect(stableStringify([...rebuilt, ...compacted.tail])).toBe(stableStringify(rewritten))
  })

  test('keeps $ref and $media placeholders inside node bodies', () => {
    const request = {
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: { $ref: 'v1/blobs/system.json.gz', kind: 'system' } },
        { role: 'user', content: [{ type: 'image_url', image_url: { $media: 'abc', mime: 'image/png' } }] },
        ...conversation(12),
      ],
    }
    const collector = collect()
    const chained = chainRequest(request, 'workspace-1', collector.write)

    expect(chained.writes).toHaveLength(collector.nodes.size)
    const appended = [...collector.nodes.values()].flatMap((body) => body.append)
    expect(appended[0].content.$ref).toBe('v1/blobs/system.json.gz')
    expect(appended[1].content[0].image_url.$media).toBe('abc')
  })

  test('chains a Responses input array and leaves a string input inline', () => {
    const collector = collect()
    const arrayInput = chainRequest({ input: conversation(24) }, 'workspace-1', collector.write)
    expect((arrayInput.request as any).input).toBeUndefined()
    expect((arrayInput.request as any).chain.list).toBe('input')

    const stringInput = chainRequest({ input: 'what changed?' }, 'workspace-1', collector.write)
    expect((stringInput.request as any).input).toBe('what changed?')
    expect((stringInput.request as any).chain).toBeUndefined()
  })

  test('leaves a short conversation with no boundary entirely inline', () => {
    process.env.PROXY_CAPTURE_CHAIN_CHUNK = '1000000'
    try {
      const collector = collect()
      const request = { messages: conversation(6) }
      const chained = chainRequest(request, 'workspace-1', collector.write)
      expect(chained.writes).toEqual([])
      expect((chained.request as any).chain).toBeUndefined()
      expect((chained.request as any).messages).toHaveLength(6)
    } finally {
      delete process.env.PROXY_CAPTURE_CHAIN_CHUNK
    }
  })

  test('does not mutate the request it was given', () => {
    const request = { model: 'gpt-5', messages: conversation(20) }
    const snapshot = stableStringify(request)
    chainRequest(request, 'workspace-1', collect().write)
    expect(stableStringify(request)).toBe(snapshot)
  })
})
