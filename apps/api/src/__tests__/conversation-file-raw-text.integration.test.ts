// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `GET /conversation-files/:id/text?raw=1` — the file as written.
 *
 * A pasted markdown plan is read back to be rendered, and the search text the
 * route serves by default is tidied (`\s*\n\s*` → `\n`, runs of spaces
 * collapsed): rendering that glues paragraphs together and destroys fenced-code
 * indentation. The `raw` read decodes the stored bytes instead, with the same
 * shape, slicing and caps. Nothing about the default read changes, and no
 * binary file may come back as text.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir

const { prisma } = await import('../lib/prisma')
const { conversationRoutes } = await import('../routes/conversations')
const service = await import('../services/conversation.service')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string
let moneyId: string

const app = new Hono()
app.route('/api', conversationRoutes({ resolveUserId: async (c) => c.req.header('x-user') ?? null }))

/** A plan with the two things `tidy` destroys: blank lines and code indentation. */
const PLAN = [
  '# Q4 plan',
  '',
  'Ship the **billing** rewrite first.',
  '',
  '- invoices',
  '  - retries',
  '- dunning',
  '',
  '```ts',
  'export function total(items: Item[]) {',
  '    return items.reduce((sum, i) => sum + i.amount, 0)',
  '}',
  '```',
  '',
  'The end.',
].join('\n')

async function upload(conversationId: string, user: string, name: string, body: Uint8Array, type: string) {
  const form = new FormData()
  form.append('file', new File([body], name, { type }))
  const res = await app.request(`/api/conversations/${conversationId}/attachments`, {
    method: 'POST',
    headers: { 'x-user': user },
    body: form,
  })
  const json: any = await res.json()
  return { status: res.status, attachment: json.attachment }
}

const post = (conversationId: string, authorUserId: string, text: string, extra: Record<string, unknown> = {}) =>
  service.postMessage({ conversationId, authorType: 'user', authorUserId, text, ...extra } as any)

async function readText(id: string, user: string, query = '') {
  const res = await app.request(`/api/conversation-files/${id}/text${query}`, { headers: { 'x-user': user } })
  return { status: res.status, json: (await res.json()) as any }
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general')!.id
  moneyId = (await service.createChannel({ workspaceId: seed.workspaceId, userId: seed.owner, name: 'money', kind: 'private' })).id
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('file text, raw and tidied', () => {
  test('raw returns the body verbatim while the default stays the search text', async () => {
    const { status, attachment } = await upload(generalId, seed.owner, 'Pasted markdown.md', new TextEncoder().encode(PLAN), 'text/markdown')
    expect(status).toBe(201)
    await post(generalId, seed.owner, 'The plan', { attachmentIds: [attachment.id] })

    const raw = await readText(attachment.id, seed.owner, '?raw=1')
    expect(raw.status).toBe(200)
    expect(raw.json.text).toBe(PLAN)
    expect(raw.json.totalChars).toBe(PLAN.length)
    expect(raw.json.nextOffset).toBeNull()
    expect(raw.json).toMatchObject({ fileId: attachment.id, name: 'Pasted markdown.md', mimeType: 'text/markdown' })

    const searched = await readText(attachment.id, seed.owner)
    expect(searched.status).toBe(200)
    // Tidied for search: no blank lines, no indentation to lean on.
    expect(searched.json.text).not.toContain('\n\n')
    expect(searched.json.text).not.toContain('    return')
    expect(searched.json.text).toContain('Ship the **billing** rewrite first.')
  })

  test('raw pages by offset and keeps the blank lines and indentation in the slice', async () => {
    const { attachment } = await upload(generalId, seed.owner, 'Pasted markdown (2).md', new TextEncoder().encode(PLAN), 'text/markdown')
    await post(generalId, seed.owner, 'Second plan', { attachmentIds: [attachment.id] })

    const head = await readText(attachment.id, seed.owner, '?raw=1&limit=20')
    expect(head.json.text).toBe(PLAN.slice(0, 20))
    expect(head.json.offset).toBe(0)
    expect(head.json.nextOffset).toBe(20)

    // Start inside the fenced block: the four-space indentation must survive.
    const codeAt = PLAN.indexOf('    return')
    const rest = await readText(attachment.id, seed.owner, `?raw=1&offset=${codeAt}&limit=40`)
    expect(rest.json.offset).toBe(codeAt)
    expect(rest.json.text?.startsWith('    return items.reduce')).toBe(true)
    expect(rest.json.totalChars).toBeGreaterThan(0)

    // The identical slice without raw is tidied, which is the behaviour to keep.
    const tidied = await readText(attachment.id, seed.owner, `?offset=${codeAt}&limit=40`)
    expect(tidied.json.text?.startsWith('    return')).toBe(false)
  })

  test('raw is null for a file that is not text', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
    const { attachment } = await upload(generalId, seed.owner, 'team.png', png, 'image/png')
    await post(generalId, seed.owner, 'The team', { attachmentIds: [attachment.id] })

    const raw = await readText(attachment.id, seed.owner, '?raw=1')
    expect(raw.status).toBe(200)
    expect(raw.json.text).toBeNull()
    expect(raw.json.totalChars).toBe(0)
  })

  test('raw keeps the visibility rule: another channel is still a 404', async () => {
    const { attachment } = await upload(moneyId, seed.owner, 'Pasted markdown.md', new TextEncoder().encode(PLAN), 'text/markdown')
    await post(moneyId, seed.owner, 'Private plan', { attachmentIds: [attachment.id] })

    // The owner reads it; a workspace member who is not in `money` does not.
    expect((await readText(attachment.id, seed.owner, '?raw=1')).status).toBe(200)
    expect((await readText(attachment.id, seed.viewer, '?raw=1')).status).toBe(404)
    expect((await readText(attachment.id, seed.outsider, '?raw=1')).status).toBe(404)
  })
})
