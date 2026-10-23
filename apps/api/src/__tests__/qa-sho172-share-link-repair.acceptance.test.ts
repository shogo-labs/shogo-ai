// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA gate for SHO-172 — a `share_file` link relayed through `project_call`
 * reached the user mangled ("invalid link").
 *
 * The production token in the report was signed for a 17.7 MB mp4 and the
 * model re-encoded the base64 payload with one extra JSON byte
 * (`"workspaceId"` → `"wworkspaceId"`), which shifts base64 alignment so every
 * character after it differs while the 43-char HMAC was copied exactly. Every
 * test here mints with the real signer, so the token and the signature are the
 * ones the download route actually verifies.
 *
 * What only a real checkout can get right, and what this file therefore drives:
 *
 * 1. AC1 — the incident's exact slip (inserted and deleted JSON byte) is
 *    repaired, and the repair distance in the *old* path (5% edit distance) is
 *    proved hopeless, so the fix is the signature match and not luck.
 * 2. AC2/AC3 — real minted tokens never collide, an unknown signature is left
 *    alone, an ambiguous signature is never guessed, and the existing near-miss
 *    repairs (a flipped character in the payload or in the signature) still
 *    work.
 * 3. The user-visible promise, end to end on desktop: the desktop download
 *    route answers the clicked (mangled) URL with the production 404
 *    `invalid_link` and answers the repaired URL with the file itself. The
 *    desktop route is the same `/f/<token>` shape the cloud route verifies
 *    with the same `shared-file-token` module, so the regex and the repair are
 *    covered for both surfaces (AC5).
 * 4. AC5 — extraction finds a token in whatever a relayed tool result looks
 *    like (JSON string, markdown link, local `localhost`/`127.0.0.1` forms) and
 *    ignores strings that only look like a share path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { diagnoseSharedFileToken, sharedFileLinkError, signSharedFileToken } from '../lib/shared-file-token'
import { localSharedFileRoutes } from '../routes/local-shared-files'
import { extractShareLinkTokens, repairShareLinks } from '../../../../packages/agent-runtime/src/share-link-repair'

const SECRET = 'qa-sho172-share-link-repair-secret'
const originalSecret = process.env.BETTER_AUTH_SECRET
const originalNodeEnv = process.env.NODE_ENV

/** The claims from the production incident (card SHO-172). */
const INCIDENT = {
  projectId: 'd3cce05d-5a1e-4c2b-9f30-6f1a2b3c4d5e',
  workspaceId: '0599aa18-8e7d-4f6a-9b21-3c4d5e6f7a8b',
  path: 'public/takes/2026-10-24-A.mp4',
  exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
}

let workspacesDir = ''

beforeAll(() => {
  workspacesDir = mkdtempSync(join(tmpdir(), 'qa-sho172-'))
})

afterAll(() => {
  rmSync(workspacesDir, { recursive: true, force: true })
  if (originalSecret === undefined) delete process.env.BETTER_AUTH_SECRET
  else process.env.BETTER_AUTH_SECRET = originalSecret
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = SECRET
})

/**
 * Re-type a minted token the way the model did: rebuild the base64 payload from
 * edited JSON and keep the signature byte for byte.
 */
function retype(token: string, edit: (json: string) => string): string {
  const [payload, signature] = token.split('.')
  const json = Buffer.from(payload, 'base64url').toString('utf8')
  return `${Buffer.from(edit(json), 'utf8').toString('base64url')}.${signature}`
}

const shiftByte = (token: string) => retype(token, (json) => json.replace('"workspaceId"', '"wworkspaceId"'))
const dropByte = (token: string) => retype(token, (json) => json.replace('"workspaceId"', '"orkspaceId"'))
const flipInSignature = (token: string) => {
  const [payload, signature] = token.split('.')
  const at = signature.length - 3
  const flipped = signature[at] === 'a' ? 'b' : 'a'
  return `${payload}.${signature.slice(0, at)}${flipped}${signature.slice(at + 1)}`
}

const url = (token: string, origin = 'https://studio.shogo.ai') => `${origin}/api/f/${token}`
const tokenOf = (shareUrl: string) => shareUrl.split('/f/')[1]

/** How many character positions differ (length delta included) — a stand-in for edit distance. */
function differingPositions(a: string, b: string): number {
  let differing = Math.abs(a.length - b.length)
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) differing++
  return differing
}

describe('AC1 — a re-encoded payload is repaired by its signature', () => {
  it('repairs the incident slip: one inserted JSON byte, signature copied exactly', () => {
    const minted = signSharedFileToken(INCIDENT)
    const clicked = shiftByte(minted)

    // The click that produced the production 404 `invalid_link`.
    const refusal = diagnoseSharedFileToken(clicked)
    expect(refusal.ok).toBe(false)
    expect(refusal.reason).toBe('signature_mismatch')
    expect(sharedFileLinkError(refusal.reason)).toMatchObject({ status: 404, code: 'invalid_link' })

    // The old path could not have reached it: an edit-distance budget is 5% of
    // the token, and one shifted byte differs almost everywhere.
    expect(differingPositions(clicked, minted)).toBeGreaterThan(Math.floor(minted.length * 0.2))

    const reply = `Here is the take: ${url(clicked)}\n\nExpires in 7 days.`
    const repaired = repairShareLinks(reply, new Set([minted]))
    expect(repaired).toBe(`Here is the take: ${url(minted)}\n\nExpires in 7 days.`)

    // What the user's click now verifies to.
    const verified = diagnoseSharedFileToken(tokenOf(repaired).split('\n')[0])
    expect(verified.ok).toBe(true)
    expect(verified.claims).toEqual(JSON.parse(Buffer.from(minted.split('.')[0], 'base64url').toString('utf8')))
  })

  it('repairs a payload that lost a byte as well as one that gained it', () => {
    const minted = signSharedFileToken(INCIDENT)
    for (const clicked of [shiftByte(minted), dropByte(minted)]) {
      expect(diagnoseSharedFileToken(clicked).reason).toBe('signature_mismatch')
      expect(repairShareLinks(url(clicked), new Set([minted]))).toBe(url(minted))
    }
  })

  it('repairs a re-encoded token whose separator was URL-encoded', () => {
    const minted = signSharedFileToken(INCIDENT)
    const clicked = shiftByte(minted)
    for (const separator of ['%2E', '%2e']) {
      const encoded = clicked.replace('.', separator)
      expect(repairShareLinks(url(encoded), new Set([minted]))).toBe(url(minted))
    }
  })
})

describe('AC2 — never guess', () => {
  const second = { ...INCIDENT, path: 'public/takes/2026-10-24-B.mp4' }

  it('two real minted tokens never collide, and a re-encoded payload resolves to its own token', () => {
    const a = signSharedFileToken(INCIDENT)
    const b = signSharedFileToken({ ...second, now: Math.floor(Date.now() / 1000) + 30 })
    expect(a).not.toBe(b)
    expect(repairShareLinks(url(shiftByte(a)), new Set([a, b]))).toBe(url(a))
    expect(repairShareLinks(url(shiftByte(b)), new Set([a, b]))).toBe(url(b))
  })

  it('leaves a token whose signature matches nothing and which is far from every minted token alone', () => {
    const minted = signSharedFileToken(INCIDENT)
    const stranger = retype(minted, (json) => json.replace(INCIDENT.path, 'public/takes/2026-10-26-C.mp4'))
    const withUnknownSignature = `${stranger.split('.')[0]}.${'Z'.repeat(43)}`
    expect(repairShareLinks(url(withUnknownSignature), new Set([minted]))).toBe(url(withUnknownSignature))
  })

  it('leaves the text unchanged when two minted tokens share a signature', () => {
    const minted = signSharedFileToken(INCIDENT)
    const [, signature] = minted.split('.')
    const twin = signSharedFileToken(second)
    const twinPayload = twin.split('.')[0]
    const candidate = shiftByte(minted)
    const ambiguous = new Set([minted, `${twinPayload}.${signature}`])
    expect(repairShareLinks(url(candidate), ambiguous)).toBe(url(candidate))
  })

  it('is idempotent and never touches an exact minted link', () => {
    const minted = signSharedFileToken(INCIDENT)
    const text = `Two links, same file:\n${url(minted)}\n${url(minted)}`
    const repaired = repairShareLinks(text, new Set([minted]))
    expect(repaired).toBe(text)
    expect(repairShareLinks(repaired, new Set([minted]))).toBe(repaired)
  })
})

describe('AC3 — the existing near-miss repairs still work', () => {
  it('repairs a single flipped character in the payload', () => {
    const minted = signSharedFileToken(INCIDENT)
    const payload = minted.split('.')[0]
    const flipped = `${payload.slice(0, 10)}${payload[10] === 'A' ? 'B' : 'A'}${payload.slice(11)}.${minted.split('.')[1]}`
    expect(repairShareLinks(url(flipped), new Set([minted]))).toBe(url(minted))
  })

  it('repairs a single flipped character inside the signature', () => {
    const minted = signSharedFileToken(INCIDENT)
    expect(repairShareLinks(url(flipInSignature(minted)), new Set([minted]))).toBe(url(minted))
  })

  it('leaves non-share `/f/` text and an empty minted set untouched', () => {
    const minted = signSharedFileToken(INCIDENT)
    expect(repairShareLinks('see /f/abc for details', new Set([minted]))).toBe('see /f/abc for details')
    expect(repairShareLinks('see /file/report.mp4', new Set([minted]))).toBe('see /file/report.mp4')
    expect(repairShareLinks(url(shiftByte(minted)), new Set())).toBe(url(shiftByte(minted)))
  })
})

describe('end to end on desktop — the clicked link 404s, the repaired link serves the file', () => {
  const workspaceId = 'qa-ws-sho172'
  const relativePath = 'public/takes/2026-10-24-A.mp4'
  const bytes = 'not really an mp4, but the bytes are what the user gets'

  beforeAll(() => {
    mkdirSync(join(workspacesDir, '.workspace-roots', workspaceId, 'public', 'takes'), { recursive: true })
    writeFileSync(join(workspacesDir, '.workspace-roots', workspaceId, relativePath), bytes)
  })

  it('404s the mangled copy and 200s the repaired one through the real download route', async () => {
    const download = localSharedFileRoutes({ workspacesDir })
    const minted = signSharedFileToken({ workspaceId, path: relativePath, exp: INCIDENT.exp })
    const clicked = shiftByte(minted)

    const refused = await download.request(`/api/f/${clicked}`)
    expect(refused.status).toBe(404)
    expect((await refused.json() as any).error.code).toBe('invalid_link')

    // The relaying `project_call` result carries the minted URL; the reply the
    // model types repeats it mangled. This is the pair the gateway now feeds
    // into `repairShareLinks`.
    const relayedToolResult = JSON.stringify({ ok: true, reply: `the take is ready: ${url(minted, 'http://localhost:5173')}` })
    const reply = `Here is the take: ${url(clicked, 'http://localhost:5173')}`
    const repaired = repairShareLinks(reply, extractShareLinkTokens([relayedToolResult]))

    // Desktop mints `/f/<token>`; both forms resolve through the same route.
    const repairedToken = tokenOf(repaired)
    expect(repairedToken).toBe(minted)
    const served = await download.request(`/f/${repairedToken}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('video/mp4')
    expect(served.headers.get('content-disposition')).toBe('attachment; filename="2026-10-24-A.mp4"')
    expect(await served.text()).toBe(bytes)

    // And the same token verifies on the verifier the cloud route uses.
    expect(diagnoseSharedFileToken(repairedToken).ok).toBe(true)
  })
})

describe('AC5 — extraction covers every surface a relayed result can come from', () => {
  it('learns tokens from JSON results, markdown links and local origins', () => {
    const a = signSharedFileToken(INCIDENT)
    const b = signSharedFileToken({ ...INCIDENT, path: 'public/takes/2026-10-24-B.mp4' })
    const local = signSharedFileToken({ workspaceId: 'qa-ws-sho172', path: 'out/report.mp4', exp: INCIDENT.exp })
    const relayed = [
      JSON.stringify({ ok: true, reply: `take: ${url(a)}` }),
      `- [download](${url(b, 'https://studio.staging.shogo.ai')})`,
      `desktop: http://localhost:5173/f/${local}`,
      `also: http://127.0.0.1:8787/api/f/${local}`,
    ]
    expect(extractShareLinkTokens(relayed)).toEqual(new Set([a, b, local]))
  })

  it('ignores results that carry no share token', () => {
    expect(extractShareLinkTokens(['', 'no link here', 'path is out/files/report.mp4', JSON.stringify({})])).toEqual(new Set())
  })
})
