// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../gateway-tools'
import { createBoardTools } from '../board-tools'
import { publishWorkspaceMedia, readWorkspaceMedia, type MediaUploader } from '../workspace-media'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-media-'))
  mkdirSync(join(dir, 'brand'), { recursive: true })
  mkdirSync(join(dir, 'files', 'clips'), { recursive: true })
  writeFileSync(join(dir, 'brand', 'hero.png'), new Uint8Array([1, 2, 3]))
  writeFileSync(join(dir, 'files', 'clips', 'wave.mp4'), new Uint8Array([4, 5]))
  writeFileSync(join(dir, 'notes.txt'), 'hi')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('readWorkspaceMedia', () => {
  test('reads images from the root and videos from files/', () => {
    const png = readWorkspaceMedia(dir, 'brand/hero.png')
    expect('error' in png ? png.error : png.mimeType).toBe('image/png')
    const mp4 = readWorkspaceMedia(dir, './clips/wave.mp4')
    expect('error' in mp4 ? mp4.error : mp4.mimeType).toBe('video/mp4')
  })

  test('refuses paths outside the workspace and non-media files', () => {
    expect(readWorkspaceMedia(dir, '../../etc/passwd')).toEqual({ error: '../../etc/passwd: outside the workspace' })
    expect(readWorkspaceMedia(dir, '/etc/hosts')).toEqual({ error: '/etc/hosts: outside the workspace' })
    expect(readWorkspaceMedia(dir, 'notes.txt')).toEqual({ error: 'notes.txt: only images and videos can be attached' })
    expect(readWorkspaceMedia(dir, 'brand/missing.png')).toEqual({ error: 'brand/missing.png: file not found' })
  })
})

describe('publishWorkspaceMedia', () => {
  test('uploads each workspace ref once and rewrites it to the stored URL', async () => {
    const uploaded: string[] = []
    const upload: MediaUploader = async (file) => {
      uploaded.push(file.path)
      return { ok: true, status: 201, data: { id: `att-${uploaded.length}`, name: file.name, mimeType: file.mimeType, size: 1, url: `/api/conversation-files/att-${uploaded.length}?t=sig` } }
    }
    const md = '![Hero](brand/hero.png)\n![](brand/hero.png)\n![Wave](clips/wave.mp4)\n![x](https://example.com/x.png)\n```\n![c](brand/hero.png)\n```'
    const out = await publishWorkspaceMedia(md, dir, upload)

    expect(uploaded).toEqual(['brand/hero.png', 'clips/wave.mp4'])
    expect(out.uploaded).toBe(2)
    expect(out.errors).toEqual([])
    expect(out.markdown).toBe(
      '![Hero](/api/conversation-files/att-1?t=sig#hero.png)\n![](/api/conversation-files/att-1?t=sig#hero.png)\n' +
      '![Wave](/api/conversation-files/att-2?t=sig#wave.mp4)\n![x](https://example.com/x.png)\n```\n![c](brand/hero.png)\n```',
    )
  })

  test('reports refs it could not upload and leaves them as written', async () => {
    const out = await publishWorkspaceMedia('![](nope.png)', dir, async () => ({ ok: false, status: 500, error: 'boom' }))
    expect(out.markdown).toBe('![](nope.png)')
    expect(out.errors).toEqual(['nope.png: file not found'])
  })
})

describe('board tools with media', () => {
  const realFetch = globalThis.fetch
  const savedApi = process.env.SHOGO_API_URL
  let calls: Array<{ url: string; json?: any; file?: { name: string; type: string } }> = []

  beforeEach(() => {
    calls = []
    process.env.SHOGO_API_URL = 'http://api.test'
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.body instanceof FormData) {
        const file = init.body.get('file') as File
        calls.push({ url, file: { name: file.name, type: file.type } })
        const id = `att-${calls.length}`
        return Response.json({ attachment: { id, name: file.name, mimeType: file.type, size: file.size, url: `/api/conversation-files/${id}?t=sig` } }, { status: 201 })
      }
      const json = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, json })
      return Response.json({ item: { id: 'i1', key: 'ART-1', title: 'Mascot', column: { name: 'To do', category: 'backlog' } }, messageId: 'm1' }, { status: 201 })
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    if (savedApi === undefined) delete process.env.SHOGO_API_URL
    else process.env.SHOGO_API_URL = savedApi
  })

  const ctx = () => ({ workspaceDir: dir, channels: new Map(), workspaceId: 'ws-1', sessionId: 'sess-1', projectId: 'proj-1', config: {} as any }) as ToolContext
  const run = async (name: string, params: Record<string, unknown>) => {
    const tool = createBoardTools(ctx()).find((t) => t.name === name)!
    const result: any = await tool.execute('call-1', params as any)
    return JSON.parse(result.content[0].text)
  }

  test('work_item_comment uploads attachments to the card and posts their ids', async () => {
    const out = await run('work_item_comment', { item: 'ART-1', text: 'New cut', attachments: ['clips/wave.mp4', 'notes.txt'] })

    expect(calls[0]).toEqual({ url: 'http://api.test/api/internal/workspaces/ws-1/agent-work-items/ART-1/attachments', file: { name: 'wave.mp4', type: 'video/mp4' } })
    expect(calls[1].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-work-items/ART-1/comments')
    expect(calls[1].json.attachmentIds).toEqual(['att-1'])
    expect(out.media_errors).toEqual(['notes.txt: only images and videos can be attached'])
  })

  test('work_item_create uploads description media to the board first', async () => {
    await run('work_item_create', { board: 'assets', channel: 'design', title: 'Mascot', description: 'Look:\n\n![Hero](brand/hero.png)' })

    expect(calls[0].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-boards/assets/attachments?channel=design')
    expect(calls[1].url).toBe('http://api.test/api/internal/workspaces/ws-1/agent-boards/assets/items?channel=design')
    expect(calls[1].json.description).toBe('Look:\n\n![Hero](/api/conversation-files/att-1?t=sig#hero.png)')
  })
})
