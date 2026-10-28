// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Profile pictures, end to end: upload, serve, replace, remove.
 *
 * Runs the real gate (`apiAuthGate`) and the real routes against a real
 * database and a real artifact store, because two things here can only fail in
 * combination:
 *
 *  1. The serve route is exempt from session auth on purpose — a plain
 *     `<img>` / RN `<Image>` presents no credentials — so if the allowlist entry
 *     is ever dropped, every avatar in the product 401s. The gate runs for real
 *     here, so that regression fails this file.
 *  2. A replaced picture deletes its old blob, which is only safe because
 *     `author.image` is a live relation include (conversation.service.ts:161)
 *     rather than a value denormalised onto each message. If that ever becomes
 *     denormalised, old references go stale and this file's replace/remove
 *     cases are the place that will notice.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'fs'
import { Hono } from 'hono'
import { setupChannelsTestDb, seedWorkspace, type SeededWorkspace } from './helpers/channels-test-db'

const { dir } = setupChannelsTestDb()
process.env.SHOGO_DATA_DIR = dir
// Must be set before `middleware/auth` pulls in Better Auth, which refuses to
// start on the built-in default secret outside a test environment.
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret-user-avatar-routes'

const { apiAuthGate, isGatePublicPath } = await import('../middleware/api-auth-gate')
const { userProfileRoutes } = await import('../routes/local-user')
const { prisma } = await import('../lib/prisma')

const db = prisma as any

let seed: SeededWorkspace
/** The signed-in user for the next request; null means no session at all. */
let currentUserId: string | null = null

async function fakeAuth(c: any, next: any) {
  c.set('auth', currentUserId ? { isAuthenticated: true, userId: currentUserId } : { isAuthenticated: false })
  await next()
}

function buildApp(): Hono {
  const app = new Hono()
  app.use('/api/*', fakeAuth)
  app.use('/api/*', apiAuthGate)
  app.route('/api', userProfileRoutes())
  return app
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function png(width: number, height: number, padding = 0): Uint8Array {
  const bytes = new Uint8Array(24 + padding)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  writeUint32BE(bytes, 16, width)
  writeUint32BE(bytes, 20, height)
  return bytes
}

async function upload(bytes: Uint8Array, contentType = 'image/png') {
  const form = new FormData()
  form.append('file', new Blob([bytes as unknown as BlobPart], { type: contentType }), 'avatar.png')
  return buildApp().fetch(new Request('http://x/api/me/avatar', { method: 'POST', body: form }))
}

async function getAvatar(url: string) {
  return buildApp().fetch(new Request(`http://x${url}`))
}

beforeAll(async () => {
  seed = await seedWorkspace(db)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
})

describe('profile picture upload', () => {
  test('stores the picture, writes the URL itself, and returns it', async () => {
    currentUserId = seed.owner
    const bytes = png(512, 512)

    const res = await upload(bytes)
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.image).toMatch(new RegExp(`^/api/user-avatar/${seed.owner}\\?k=[a-f0-9]{16}\\.png&t=[a-f0-9]{64}$`))

    const row = await db.user.findUnique({ where: { id: seed.owner }, select: { image: true } })
    expect(row.image).toBe(body.data.image)
  })

  test('requires a session', async () => {
    currentUserId = null
    expect((await upload(png(512, 512))).status).toBe(401)
  })

  test('rejects a body that is not really an image, whatever its Content-Type claims', async () => {
    currentUserId = seed.owner
    const pdf = new TextEncoder().encode('%PDF-1.7 not an image at all')
    const res = await upload(pdf, 'image/png')
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('unsupported_format')
  })

  test('rejects an empty body', async () => {
    currentUserId = seed.owner
    const res = await upload(new Uint8Array(0))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('empty_file')
  })

  test('enforces the 1 MB cap', async () => {
    currentUserId = seed.owner
    const res = await upload(png(512, 512, 1024 * 1024))
    expect([400, 413]).toContain(res.status)
    expect((await res.json() as any).error.code).toBe('file_too_large')
  })

  test('enforces the dimension ceiling even for bytes that compress small', async () => {
    currentUserId = seed.owner
    const res = await upload(png(4000, 4000))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error.code).toBe('image_too_large')
  })
})

describe('serving a profile picture', () => {
  test('serves the bytes to an <img> with no session and no cookie', async () => {
    currentUserId = seed.owner
    const bytes = png(512, 512)
    const { data } = await (await upload(bytes)).json() as any

    // No session: this is the whole point of the token-gated route.
    currentUserId = null
    const res = await getAvatar(data.image)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(res.headers.get('cache-control')).toContain('max-age=86400')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  test('is exempt from the session gate', () => {
    expect(isGatePublicPath('/api/user-avatar/user_1')).toBe(true)
    // But nothing else under /api/me became public.
    expect(isGatePublicPath('/api/me')).toBe(false)
    expect(isGatePublicPath('/api/me/avatar')).toBe(false)
  })

  test('403s a bad token rather than serving the picture', async () => {
    currentUserId = seed.owner
    const { data } = await (await upload(png(512, 512))).json() as any
    currentUserId = null

    const tampered = data.image.replace(/t=[a-f0-9]{64}/, `t=${'0'.repeat(64)}`)
    expect((await getAvatar(tampered)).status).toBe(403)
    expect((await getAvatar(data.image.replace(/&t=.*$/, ''))).status).toBe(403)
    // A missing key is malformed before it is unauthorised.
    expect((await getAvatar(data.image.replace(/\?.*$/, ''))).status).toBe(400)
  })

  test('400s a hand-edited content key', async () => {
    currentUserId = seed.owner
    const { data } = await (await upload(png(512, 512))).json() as any
    const token = /t=([a-f0-9]{64})/.exec(data.image)![1]
    currentUserId = null

    expect((await getAvatar(`/api/user-avatar/${seed.owner}?k=abc.svg&t=${token}`)).status).toBe(400)
    expect((await getAvatar(`/api/user-avatar/${seed.owner}?k=../../etc/passwd&t=${token}`)).status).toBe(400)
    // A traversal attempt in the path never reaches the route at all: URL
    // normalisation collapses it to /api/evil, which is not a public path.
    expect((await getAvatar(`/api/user-avatar/../evil?k=abcdef0123456789.png&t=${token}`)).status).toBe(401)
  })

  test('404s a valid link whose picture is gone', async () => {
    currentUserId = seed.owner
    const { data } = await (await upload(png(512, 512))).json() as any
    currentUserId = null

    const missing = data.image.replace(/k=[a-f0-9]{16}/, 'k=0123456789abcdef')
    // The signature no longer matches the key, so build a valid token for it
    // by asking the module directly — the point here is the missing blob.
    const { avatarUrl } = await import('../lib/user-avatar')
    const url = avatarUrl(seed.owner, '0123456789abcdef.png')
    expect((await getAvatar(url)).status).toBe(404)
    expect(missing).toBeTruthy()
  })
})

describe('replacing and removing a profile picture', () => {
  test('a new picture replaces the old one and removes its blob', async () => {
    currentUserId = seed.owner
    const first = await (await upload(png(512, 512))).json() as any
    const second = await (await upload(png(512, 511))).json() as any

    expect(second.data.image).not.toBe(first.data.image)
    const row = await db.user.findUnique({ where: { id: seed.owner }, select: { image: true } })
    expect(row.image).toBe(second.data.image)

    currentUserId = null
    expect((await getAvatar(second.data.image)).status).toBe(200)
    expect((await getAvatar(first.data.image)).status).toBe(404)
  })

  test('re-uploading the same picture keeps the blob it just wrote', async () => {
    currentUserId = seed.owner
    const bytes = png(256, 256)
    const first = await (await upload(bytes)).json() as any
    const second = await (await upload(bytes)).json() as any

    // Same content hash, so the delete-the-old-blob step must skip it — otherwise
    // the URL we just handed back would already be broken.
    expect(second.data.image).toBe(first.data.image)
    currentUserId = null
    expect((await getAvatar(second.data.image)).status).toBe(200)
  })

  test('removing clears the column and drops the blob, so the UI falls back to initials', async () => {
    currentUserId = seed.owner
    const { data } = await (await upload(png(512, 512))).json() as any

    const res = await buildApp().fetch(new Request('http://x/api/me/avatar', { method: 'DELETE' }))
    expect(res.status).toBe(200)
    expect((await res.json() as any).data.image).toBeNull()

    const row = await db.user.findUnique({ where: { id: seed.owner }, select: { image: true } })
    expect(row.image).toBeNull()

    currentUserId = null
    expect((await getAvatar(data.image)).status).toBe(404)
  })

  test('removing requires a session', async () => {
    currentUserId = null
    const res = await buildApp().fetch(new Request('http://x/api/me/avatar', { method: 'DELETE' }))
    expect(res.status).toBe(401)
  })

  test('removing an OAuth photo clears the column without touching any blob', async () => {
    currentUserId = seed.member
    await db.user.update({
      where: { id: seed.member },
      data: { image: 'https://lh3.googleusercontent.com/a/oauth-photo' },
    })

    const res = await buildApp().fetch(new Request('http://x/api/me/avatar', { method: 'DELETE' }))
    expect(res.status).toBe(200)
    const row = await db.user.findUnique({ where: { id: seed.member }, select: { image: true } })
    expect(row.image).toBeNull()
  })
})
