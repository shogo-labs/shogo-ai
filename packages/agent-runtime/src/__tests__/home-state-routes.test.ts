// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `/pool/export-home` + `/pool/hydrate-home` handler contract: gating, status
 * codes, conditional export, and a full export -> hydrate round trip.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { handleExportHome, handleHydrateHome, homeStateConfigFromEnv } from '../home-state-routes'

let root: string
const KEY = randomBytes(32).toString('base64')

function envFor(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    SHOGO_DURABILITY_HOST_MEDIATED: '1',
    PROJECT_ID: 'proj-1',
    HOME_STATE_KEY: KEY,
    HOME_STATE_KEY_VERSION: '1',
    SHOGO_HOME_STATE_DIR: home,
    ...extra,
  }
}

function put(home: string, rel: string, body: string, mode = 0o644): void {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
  chmodSync(p, mode)
}

const post = (headers: Record<string, string> = {}, body?: Uint8Array) =>
  new Request('http://guest/pool/x', { method: 'POST', headers, body: body as BodyInit | undefined })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'home-routes-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('gating', () => {
  test('enabled only for a host-mediated guest with a key and a real project', () => {
    const home = join(root, 'h')
    expect(homeStateConfigFromEnv(envFor(home))).not.toBeNull()
    expect(homeStateConfigFromEnv(envFor(home, { SHOGO_DURABILITY_HOST_MEDIATED: '' }))).toBeNull()
    expect(homeStateConfigFromEnv(envFor(home, { HOME_STATE_KEY: '' }))).toBeNull()
    expect(homeStateConfigFromEnv(envFor(home, { PROJECT_ID: '__POOL__' }))).toBeNull()
  })

  test('both endpoints answer 404 when disabled, so the host marks the VM unsupported', async () => {
    const env = { PROJECT_ID: 'p', HOME: join(root, 'h') }
    expect((await handleExportHome(post(), { env, stageDir: () => root })).status).toBe(404)
    expect((await handleHydrateHome(post({}, new Uint8Array([1])), { env })).status).toBe(404)
  })
})

describe('export', () => {
  test('204 when nothing is persisted', async () => {
    const home = join(root, 'h')
    mkdirSync(home)
    const res = await handleExportHome(post(), { env: envFor(home), stageDir: () => root })
    expect(res.status).toBe(204)
  })

  test('200 with ciphertext and an ETag, then 304 for the same tag', async () => {
    const home = join(root, 'h')
    put(home, '.oci/config', 'tenancy=ocid1.secret', 0o600)
    const env = envFor(home)

    const first = await handleExportHome(post(), { env, stageDir: () => root })
    expect(first.status).toBe(200)
    const tag = first.headers.get('etag')!
    expect(tag).toBeTruthy()
    const blob = new Uint8Array(await first.arrayBuffer())
    expect(Buffer.from(blob).includes(Buffer.from('ocid1.secret'))).toBe(false)

    const again = await handleExportHome(post({ 'If-None-Match': tag }), { env, stageDir: () => root })
    expect(again.status).toBe(304)

    put(home, '.oci/config', 'tenancy=changed', 0o600)
    const changed = await handleExportHome(post({ 'If-None-Match': tag }), { env, stageDir: () => root })
    expect(changed.status).toBe(200)
  })
})

describe('hydrate', () => {
  test('export from one home restores into another', async () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    put(a, '.ssh/id_ed25519', 'PRIVATE', 0o600)
    put(a, '.kube/config', 'apiVersion: v1')
    mkdirSync(b)

    const exp = await handleExportHome(post(), { env: envFor(a), stageDir: () => root })
    const blob = new Uint8Array(await exp.arrayBuffer())
    const res = await handleHydrateHome(post({}, blob), { env: envFor(b) })
    expect(res.status).toBe(200)
    expect((await res.json()).units).toEqual(expect.arrayContaining(['.ssh', '.kube']))
    expect(readFileSync(join(b, '.ssh/id_ed25519'), 'utf-8')).toBe('PRIVATE')
    expect(lstatSync(join(b, '.ssh/id_ed25519')).mode & 0o777).toBe(0o600)
  })

  test('422 for a blob encrypted for a different project', async () => {
    const a = join(root, 'a')
    put(a, '.netrc', 'machine x', 0o600)
    const exp = await handleExportHome(post(), { env: envFor(a), stageDir: () => root })
    const blob = new Uint8Array(await exp.arrayBuffer())
    const res = await handleHydrateHome(post({}, blob), { env: envFor(join(root, 'b'), { PROJECT_ID: 'other' }) })
    expect(res.status).toBe(422)
  })

  test('400 for an empty body, 422 for garbage', async () => {
    const env = envFor(join(root, 'b'))
    expect((await handleHydrateHome(post({}, new Uint8Array()), { env })).status).toBe(400)
    expect((await handleHydrateHome(post({}, new Uint8Array(200)), { env })).status).toBe(422)
  })
})
