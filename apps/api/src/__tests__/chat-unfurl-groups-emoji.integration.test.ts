// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Link previews (with the SSRF guard), user groups and @group mentions,
 * and custom emoji against a real SQLite database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { seedWorkspace, setupChannelsTestDb, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir

const { prisma } = await import('../lib/prisma')
const bus = await import('../lib/conversation-bus')
const service = await import('../services/conversation.service')
const presence = await import('../services/conversation-presence')
const notifications = await import('../services/conversation-notifications')
const unfurl = await import('../services/conversation-unfurl')
const safe = await import('../lib/safe-fetch')
const custom = await import('../services/chat-customization')
const { groupMentionToken } = await import('../services/conversation-mentions')

const db = prisma as any
let seed: SeededWorkspace
let generalId: string

beforeAll(async () => {
  await bus._resetConversationBusForTests(null)
  seed = await seedWorkspace(db)
  for (const user of [seed.owner, seed.member, seed.viewer]) {
    await service.listConversationsForUser(seed.workspaceId, user)
  }
  const list = await service.listConversationsForUser(seed.workspaceId, seed.owner)
  generalId = list.find((c: any) => c.slug === 'general')!.id
})

beforeEach(() => {
  presence._resetPresenceForTests()
  notifications._setPushSenderForTests(async () => {})
})

afterAll(async () => {
  notifications._setPushSenderForTests(null)
  unfurl._setUnfurlFetcherForTests(null)
  safe._setResolverForTests(null)
  await (prisma as any).$disconnect?.()
  rmSync(dir, { recursive: true, force: true })
})

describe('SSRF guard', () => {
  test('private, loopback, link-local, and mapped addresses are private', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(safe.isPrivateAddress(ip)).toBe(true)
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) expect(safe.isPrivateAddress(ip)).toBe(false)
  })

  test('hosts that resolve to private addresses, odd ports, and credentials are refused', async () => {
    safe._setResolverForTests(async (host) => (host === 'evil.example' ? ['10.0.0.5'] : ['93.184.216.34']))
    await expect(safe.assertPublicUrl('http://evil.example/')).rejects.toThrow('private')
    await expect(safe.assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow()
    await expect(safe.assertPublicUrl('http://ok.example:6379/')).rejects.toThrow('Port')
    await expect(safe.assertPublicUrl('http://u:p@ok.example/')).rejects.toThrow('Credentials')
    await expect(safe.assertPublicUrl('file:///etc/passwd')).rejects.toThrow()
    expect((await safe.assertPublicUrl('https://ok.example/a')).hostname).toBe('ok.example')
  })

  test('connections go to the validated address, not a fresh DNS answer', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => new Response(`host=${new URL(req.url).hostname}`) })
    try {
      const res = await safe.requestPinned(new URL(`http://does-not-resolve.invalid:${server.port}/`), '127.0.0.1', {
        headers: {}, maxBytes: 1024, signal: AbortSignal.timeout(2_000),
      })
      expect(res.status).toBe(200)
      expect(new TextDecoder().decode(res.body)).toBe('host=does-not-resolve.invalid')
    } finally {
      server.stop(true)
    }
  })

  test('a host that re-resolves to a private address after the check is still fetched at the public one', async () => {
    let lookups = 0
    safe._setResolverForTests(async () => (lookups++ === 0 ? ['93.184.216.34'] : ['10.0.0.5']))
    const used: string[] = []
    safe._setTransportForTests(async (_url, address) => {
      used.push(address)
      return { status: 200, headers: { 'content-type': 'text/html' }, body: new TextEncoder().encode('<title>ok</title>') }
    })
    try {
      const res = await safe.safeFetchText('https://rebind.example/')
      expect(res.body).toBe('<title>ok</title>')
      expect(used).toEqual(['93.184.216.34'])
      expect(lookups).toBe(1)
    } finally {
      safe._setTransportForTests(null)
    }
  })

  test('each redirect hop is re-validated and bodies are capped', async () => {
    safe._setResolverForTests(async (host) => (host === 'internal.example' ? ['10.0.0.5'] : ['93.184.216.34']))
    safe._setTransportForTests(async (url) => url.hostname === 'start.example'
      ? { status: 302, headers: { location: 'http://internal.example/admin' }, body: new Uint8Array() }
      : { status: 200, headers: {}, body: new Uint8Array() })
    try {
      await expect(safe.safeFetchText('https://start.example/')).rejects.toThrow('private')
    } finally {
      safe._setTransportForTests(null)
    }
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x'.repeat(100_000)) })
    try {
      const res = await safe.requestPinned(new URL(`http://big.test:${server.port}/`), '127.0.0.1', {
        headers: {}, maxBytes: 1000, signal: AbortSignal.timeout(2_000),
      })
      expect(res.body.byteLength).toBe(1000)
    } finally {
      server.stop(true)
    }
  })
})

describe('link previews', () => {
  test('extracts up to three links, skipping <suppressed> ones and code', () => {
    expect(unfurl.extractLinks('see https://a.dev/x, and <https://b.dev> plus `https://c.dev` https://d.dev/y?z=1.')).toEqual([
      'https://a.dev/x', 'https://d.dev/y?z=1',
    ])
  })

  test('parses Open Graph tags with a <title> fallback and drops non-https images', () => {
    const og = unfurl.parseUnfurl('https://a.dev/post', `<head><meta property="og:title" content="Launch &amp; learn">
      <meta content="All the details" property="og:description"><meta property="og:image" content="/cover.png">
      <meta property="og:site_name" content="A Dev"></head>`)
    expect(og).toEqual({ url: 'https://a.dev/post', title: 'Launch & learn', description: 'All the details', image: 'https://a.dev/cover.png', siteName: 'A Dev' })
    const plain = unfurl.parseUnfurl('http://www.b.dev/', '<title> Plain page </title><meta property="og:image" content="http://b.dev/i.png">')
    expect(plain).toMatchObject({ title: 'Plain page', image: null, siteName: 'b.dev' })
    expect(unfurl.parseUnfurl('https://c.dev', '<p>no title</p>')).toBeNull()
  })

  test('posted links get previews stored on the message; failures are cached and skipped', async () => {
    const fetched: string[] = []
    unfurl._setUnfurlFetcherForTests(async (url) => {
      fetched.push(url)
      if (url.includes('broken')) throw new Error('boom')
      return { url, status: 200, contentType: 'text/html', body: `<title>Page ${url.slice(-1)}</title>` }
    })
    const result = await service.postMessage({
      conversationId: generalId, authorType: 'user', authorUserId: seed.owner, text: 'https://x.dev/1 and https://broken.dev/2',
    } as any)
    const unfurls = await unfurl.unfurlMessage(result)
    expect(unfurls.map((u) => u.title)).toEqual(['Page 1'])
    const row = await db.conversationMessage.findUnique({ where: { id: result.row.id } })
    const blocks = typeof row.blocks === 'string' ? JSON.parse(row.blocks) : row.blocks
    expect(blocks.unfurls[0].url).toBe('https://x.dev/1')

    await unfurl.unfurlMessage(await service.postMessage({
      conversationId: generalId, authorType: 'user', authorUserId: seed.owner, text: 'again https://x.dev/1 https://broken.dev/2',
    } as any))
    expect(fetched.sort()).toEqual(['https://broken.dev/2', 'https://x.dev/1'])
  })

  test('edits and finished agent replies get previews; removed links lose their cards', async () => {
    unfurl._setUnfurlFetcherForTests(async (url) => ({ url, status: 200, contentType: 'text/html', body: `<title>Page ${url.slice(-1)}</title>` }))
    const settled: string[] = []
    service.onMessageTextSettled((row) => {
      settled.push(row.id)
      void unfurl.refreshUnfurls(row)
    })
    const stored = async (id: string) => {
      const row = await db.conversationMessage.findUnique({ where: { id } })
      const blocks = typeof row.blocks === 'string' ? JSON.parse(row.blocks) : row.blocks
      return (blocks?.unfurls ?? []).map((u: any) => u.url)
    }
    const waitForUrls = async (id: string, urls: string[]) => {
      for (let i = 0; i < 50 && JSON.stringify(await stored(id)) !== JSON.stringify(urls); i++) await Bun.sleep(10)
      expect(await stored(id)).toEqual(urls)
    }

    const posted = await service.postMessage({ conversationId: generalId, authorType: 'user', authorUserId: seed.owner, text: 'draft https://e.dev/1' } as any)
    await unfurl.unfurlMessage(posted)
    await service.editMessage(posted.row.id, seed.owner, 'final https://e.dev/2')
    await waitForUrls(posted.row.id, ['https://e.dev/2'])
    await service.editMessage(posted.row.id, seed.owner, 'no links now')
    await waitForUrls(posted.row.id, [])

    const agent = await service.postMessage({
      conversationId: generalId, authorType: 'agent', authorAgentRef: { projectId: null, name: 'Shogo' }, text: '', agentStatus: 'running',
    } as any)
    await service.updateMessageInternal(agent.row.id, { text: 'working on https://a.dev/3' })
    expect(settled).not.toContain(agent.row.id)
    await service.updateMessageInternal(agent.row.id, { text: 'Done: https://a.dev/3', agentStatus: 'done' })
    await waitForUrls(agent.row.id, ['https://a.dev/3'])
  })
})

describe('user groups', () => {
  test('validates handles, rejects duplicates and viewers, and keeps only workspace members', async () => {
    await expect(custom.createGroup(seed.workspaceId, seed.owner, { handle: 'Here' })).rejects.toThrow('reserved')
    await expect(custom.createGroup(seed.workspaceId, seed.owner, { handle: 'a' })).rejects.toThrow('Handles')
    await expect(custom.createGroup(seed.workspaceId, seed.viewer, { handle: 'viewers' })).rejects.toThrow('Viewers')
    const g = await custom.createGroup(seed.workspaceId, seed.owner, { handle: '@Design', name: 'Design', memberIds: [seed.member, seed.outsider] })
    expect(g).toMatchObject({ handle: 'design', memberIds: [seed.member] })
    await expect(custom.createGroup(seed.workspaceId, seed.member, { handle: 'design' })).rejects.toThrow('already exists')
  })

  test('@group mentions notify every member like a direct mention and count as mentions', async () => {
    const g = (await custom.listGroups(seed.workspaceId)).find((x: any) => x.handle === 'design')!
    await custom.updateGroup(g.id, seed.member, { memberIds: [seed.member, seed.viewer] })
    const result = await service.postMessage({
      conversationId: generalId, authorType: 'user', authorUserId: seed.owner, text: `${groupMentionToken(g.id)} review please`,
    } as any)
    const recipients = (await notifications.notifyForMessage(result)).map((r) => `${r.userId}:${r.reason}`).sort()
    expect(recipients).toEqual([`${seed.member}:mention`, `${seed.viewer}:mention`].sort())
    const list = await service.listConversationsForUser(seed.workspaceId, seed.viewer)
    expect(list.find((c: any) => c.id === generalId)!.mentionCount).toBeGreaterThan(0)
  })

  test('only the creator or an admin can delete a group', async () => {
    const g = await custom.createGroup(seed.workspaceId, seed.member, { handle: 'eng' })
    const other = await custom.createGroup(seed.workspaceId, seed.member, { handle: 'ops' })
    await expect(custom.deleteGroup(g.id, seed.viewer)).rejects.toThrow()
    expect(await custom.deleteGroup(g.id, seed.member)).toEqual({ deleted: true })
    expect(await custom.deleteGroup(other.id, seed.owner)).toEqual({ deleted: true })
  })
})

describe('custom emoji', () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  test('upload, list with signed URLs, validation, and delete permissions', async () => {
    const e = await custom.createEmoji(seed.workspaceId, seed.member, { name: ':ShipIt:', bytes: png, mimeType: 'image/png' })
    expect(e.name).toBe('shipit')
    expect(e.url).toMatch(new RegExp(`^/api/custom-emoji/${e.id}\\?t=[0-9a-f]{64}$`))
    await expect(custom.createEmoji(seed.workspaceId, seed.owner, { name: 'shipit', bytes: png, mimeType: 'image/png' })).rejects.toThrow('already exists')
    await expect(custom.createEmoji(seed.workspaceId, seed.owner, { name: 'x', bytes: png, mimeType: 'image/png' })).rejects.toThrow('names')
    await expect(custom.createEmoji(seed.workspaceId, seed.owner, { name: 'svg', bytes: png, mimeType: 'image/svg+xml' })).rejects.toThrow('PNG')
    await expect(custom.createEmoji(seed.workspaceId, seed.owner, { name: 'big', bytes: new Uint8Array(300 * 1024), mimeType: 'image/png' })).rejects.toThrow('256 KB')
    await expect(custom.createEmoji(seed.workspaceId, seed.viewer, { name: 'nope', bytes: png, mimeType: 'image/png' })).rejects.toThrow('Viewers')
    expect((await custom.listEmoji(seed.workspaceId)).map((x: any) => x.name)).toEqual(['shipit'])

    const theirs = await custom.createEmoji(seed.workspaceId, seed.owner, { name: 'party', bytes: png, mimeType: 'image/png' })
    await expect(custom.deleteEmoji(theirs.id, seed.member)).rejects.toThrow('uploader')
    await custom.deleteEmoji(e.id, seed.member)
    await custom.deleteEmoji(theirs.id, seed.owner)
    expect(await custom.listEmoji(seed.workspaceId)).toEqual([])
  })
})
