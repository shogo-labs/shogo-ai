// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Speed + size budgets for home-state, on the paths that sit in front of users:
 *
 *   - tag (idle check): runs for EVERY assigned VM on every export cycle, so it
 *     has to cost a stat walk and nothing more.
 *   - export (scan + tar + encrypt): one per change, and on suspend.
 *   - restore (decrypt + validate + extract + swap): on the cold-boot path,
 *     before the guest serves chat.
 *
 * Budgets are deliberately loose (several times the measured cost on a laptop)
 * so this catches a regression in kind — an accidental full read, a quadratic
 * walk — rather than flaking on a busy CI runner. Measured numbers are printed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  decryptHomeState,
  encryptHomeState,
  homeStateTag,
  packHomeState,
  restoreHomeState,
  scanHomeState,
  type HomeStateKey,
} from '../home-state'

const KEY: HomeStateKey = { key: randomBytes(32), version: 1 }
const PROJECT = 'perf-project'
let root: string
const rows: string[] = []

function put(home: string, rel: string, body: string | Uint8Array, mode = 0o644): void {
  const p = join(home, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
  chmodSync(p, mode)
}

/** What an agent doing ops work actually leaves behind. */
function typicalHome(home: string): void {
  put(home, '.ssh/id_ed25519', randomBytes(300).toString('base64'), 0o600)
  put(home, '.ssh/id_ed25519.pub', 'ssh-ed25519 AAAA... agent@shogo')
  put(home, '.ssh/known_hosts', 'github.com ssh-ed25519 AAAA...\n'.repeat(5))
  put(home, '.ssh/config', 'Host bastion\n  User opc\n')
  put(home, '.oci/config', '[DEFAULT]\nuser=ocid1.user\nfingerprint=aa:bb\ntenancy=ocid1.tenancy\nregion=us-ashburn-1\n')
  put(home, '.oci/oci_api_key.pem', randomBytes(1200).toString('base64'), 0o600)
  put(home, '.oci/oci_api_key_public.pem', randomBytes(300).toString('base64'))
  put(home, '.kube/config', `apiVersion: v1\nclusters: []\n${randomBytes(2000).toString('base64')}`, 0o600)
  put(home, '.aws/credentials', '[default]\naws_access_key_id=AKIA\naws_secret_access_key=x\n', 0o600)
  put(home, '.config/gh/hosts.yml', 'github.com:\n  oauth_token: gho_x\n')
  put(home, '.gitconfig', '[user]\n  name = agent\n')
}

async function timeIt<T>(fn: () => Promise<T> | T, runs = 5): Promise<{ ms: number; value: T }> {
  let value!: T
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    value = await fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return { ms: samples[Math.floor(samples.length / 2)], value }
}

async function exportOnce(home: string, stage: string): Promise<Uint8Array> {
  const scan = scanHomeState(home)
  const pack = await packHomeState(home, { stageDir: stage, scan })
  return encryptHomeState(pack!.gz, { key: KEY, projectId: PROJECT })
}

async function restoreOnce(blob: Uint8Array): Promise<void> {
  const target = mkdtempSync(join(root, 'restore-'))
  await restoreHomeState(target, decryptHomeState(blob, { key: KEY, projectId: PROJECT }), { sameOwner: false })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'home-perf-'))
})

afterAll(() => {
  console.log(['', 'home-state performance (median):', ...rows].join('\n  '))
  rmSync(root, { recursive: true, force: true })
})

describe('home-state performance', () => {
  test('typical credential set: tiny blob, fast idle check, fast export and restore', async () => {
    const home = join(root, 'typical')
    typicalHome(home)
    const stage = join(root, 'stage-typical')

    const tag = await timeIt(() => homeStateTag(scanHomeState(home)), 20)
    const exp = await timeIt(() => exportOnce(home, stage))
    const res = await timeIt(() => restoreOnce(exp.value))

    rows.push(
      `typical (11 files): tag ${tag.ms.toFixed(2)}ms · export ${exp.ms.toFixed(1)}ms · ` +
        `restore ${res.ms.toFixed(1)}ms · blob ${exp.value.byteLength} B`,
    )
    expect(exp.value.byteLength).toBeLessThan(8 * 1024)
    expect(tag.ms).toBeLessThan(25)
    expect(exp.ms).toBeLessThan(500)
    expect(res.ms).toBeLessThan(500)
  })

  test('idle check stays a stat walk with a busy ~/.config (2000 files)', async () => {
    const home = join(root, 'busy')
    typicalHome(home)
    for (let t = 0; t < 20; t++) {
      for (let f = 0; f < 100; f++) put(home, `.config/tool${t}/f${f}.json`, `{"i":${f}}`)
    }
    const tag = await timeIt(() => homeStateTag(scanHomeState(home)), 10)
    const exp = await timeIt(() => exportOnce(home, join(root, 'stage-busy')), 3)
    const res = await timeIt(() => restoreOnce(exp.value), 3)
    rows.push(
      `busy (2011 files): tag ${tag.ms.toFixed(1)}ms · export ${exp.ms.toFixed(1)}ms · ` +
        `restore ${res.ms.toFixed(1)}ms · blob ${(exp.value.byteLength / 1024).toFixed(1)} KB`,
    )
    expect(tag.ms).toBeLessThan(250)
    expect(exp.ms).toBeLessThan(2000)
    expect(res.ms).toBeLessThan(2000)
  })

  test('a large incompressible file (8 MB, e.g. a CLI binary) stays within budget', async () => {
    const home = join(root, 'large')
    typicalHome(home)
    put(home, '.config/sometool/bin', randomBytes(8 * 1024 * 1024), 0o755)
    const exp = await timeIt(() => exportOnce(home, join(root, 'stage-large')), 3)
    const res = await timeIt(() => restoreOnce(exp.value), 3)
    rows.push(
      `large (8 MB random): export ${exp.ms.toFixed(1)}ms · restore ${res.ms.toFixed(1)}ms · ` +
        `blob ${(exp.value.byteLength / 1024 / 1024).toFixed(2)} MB`,
    )
    expect(exp.ms).toBeLessThan(3000)
    expect(res.ms).toBeLessThan(3000)
  })

  test('encryption itself is negligible next to tar', async () => {
    const gz = randomBytes(1024 * 1024)
    const enc = await timeIt(() => encryptHomeState(gz, { key: KEY, projectId: PROJECT }), 10)
    const dec = await timeIt(() => decryptHomeState(enc.value, { key: KEY, projectId: PROJECT }), 10)
    rows.push(`AES-256-GCM on 1 MB: encrypt ${enc.ms.toFixed(2)}ms · decrypt ${dec.ms.toFixed(2)}ms`)
    expect(enc.ms).toBeLessThan(50)
    expect(dec.ms).toBeLessThan(50)
  })
})
