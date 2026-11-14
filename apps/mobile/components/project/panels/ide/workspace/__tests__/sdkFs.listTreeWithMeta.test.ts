// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, mock, test } from 'bun:test'
import { SdkFs } from '../sdkFs'

const tree = (body: unknown) => mock(async () => new Response(JSON.stringify(body), { status: 200 }))

describe('SdkFs.listTreeWithMeta', () => {
  test('passes the runtime truncation flag through; stub folders stay lazy', async () => {
    const fetchImpl = tree({
      tree: [
        { name: 'app.py', path: 'app.py', type: 'file', modified: 0, stub: true },
        { name: 'src', path: 'src', type: 'directory', lazy: true, stub: true, modified: 0 },
      ],
      truncated: true,
      truncatedReason: 'time',
    })
    const fs = new SdkFs('http://agent.test', 'ide', fetchImpl as any)
    expect(await fs.listTreeWithMeta()).toEqual({
      nodes: [
        { name: 'src', path: 'src', kind: 'dir', lazy: true },
        { name: 'app.py', path: 'app.py', kind: 'file', language: 'python' },
      ],
      truncated: true,
    })
  })

  test('an older runtime without the flag is complete', async () => {
    const fs = new SdkFs('http://agent.test', 'ide', tree({ tree: [] }) as any)
    expect((await fs.listTreeWithMeta()).truncated).toBe(false)
  })

  test('listTree returns the nodes of the same request', async () => {
    const fetchImpl = tree({ tree: [{ name: 'a.ts', path: 'a.ts', type: 'file' }], truncated: true })
    const fs = new SdkFs('http://agent.test', 'ide', fetchImpl as any)
    expect((await fs.listTree('src')).map((n) => n.name)).toEqual(['a.ts'])
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('/agent/workspace/tree?path=src')
  })
})
