// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The shared half of SHO-384: which names travel, which live names a slot says
 * are deleted, and what a payload is allowed to contain.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WORKSPACE_ROOT_SECRETS_VERSION,
  WORKSPACE_SECRET_SLOT_ROOT,
  applyWorkspaceSecretSlot,
  collectWorkspaceSecretSlot,
  emptyWorkspaceRootSecrets,
  isWorkspaceSecretFile,
  staleWorkspaceSecretNames,
  validateWorkspaceRootSecrets,
  workspaceRuntimeKey,
  workspaceSecretsTag,
} from '../workspace-root-secrets'

function root(prefix = 'ws-root-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('isWorkspaceSecretFile', () => {
  test('takes .env, .env.local and .env.<mode>, not the committed templates', () => {
    expect(isWorkspaceSecretFile('.env')).toBe(true)
    expect(isWorkspaceSecretFile('.env.local')).toBe(true)
    expect(isWorkspaceSecretFile('.env.production')).toBe(true)
    expect(isWorkspaceSecretFile('.env.example')).toBe(false)
    expect(isWorkspaceSecretFile('.env.local.sample')).toBe(false)
    expect(isWorkspaceSecretFile('env')).toBe(false)
    expect(isWorkspaceSecretFile('.envrc')).toBe(false)
    expect(isWorkspaceSecretFile('package.json')).toBe(false)
  })
})

describe('staleWorkspaceSecretNames', () => {
  test('names a live .env the payload no longer carries, and nothing else', () => {
    const stale = staleWorkspaceSecretNames(
      ['.env', '.env.local', '.env.example', 'package.json', '.gitignore'],
      ['.env'],
    )
    expect(stale).toEqual(['.env.local'])
  })

  test('an empty payload set means every live .env is stale', () => {
    expect(staleWorkspaceSecretNames(['.env', '.env.test'], [])).toEqual(['.env', '.env.test'])
  })
})

describe('collectWorkspaceSecretSlot', () => {
  test('captures the .env* bytes and reports what it will not carry', () => {
    const dir = root()
    writeFileSync(join(dir, '.env'), 'TOKEN=abc\n')
    writeFileSync(join(dir, '.env.local'), 'LOCAL=1\n')
    writeFileSync(join(dir, '.env.example'), 'TOKEN=\n')
    writeFileSync(join(dir, 'index.ts'), 'export {}\n')

    const { slot, skipped } = collectWorkspaceSecretSlot(dir)
    expect(slot.slot).toBe(WORKSPACE_SECRET_SLOT_ROOT)
    expect(slot.files.map((f) => f.name).sort()).toEqual(['.env', '.env.local'])
    expect(Buffer.from(slot.files[0]!.content, 'base64').toString()).toBe('TOKEN=abc\n')
    expect(slot.files.every((f) => f.mode === 0o600)).toBe(true)
    expect(skipped).toEqual([])
  })

  test('a root with no .env* is a slot with no files, not a missing slot', () => {
    const dir = root()
    writeFileSync(join(dir, '.env.example'), 'X=\n')
    const { slot } = collectWorkspaceSecretSlot(dir)
    expect(slot.files).toEqual([])
  })
})

describe('applyWorkspaceSecretSlot', () => {
  test('writes byte-identical files at 0600 and prunes names the slot does not carry', () => {
    const dir = root()
    writeFileSync(join(dir, '.env'), 'OLD=1\n')
    writeFileSync(join(dir, '.env.staging'), 'STALE=1\n')
    writeFileSync(join(dir, 'package.json'), '{}\n')

    const payload = {
      slot: WORKSPACE_SECRET_SLOT_ROOT,
      files: [{ name: '.env', content: Buffer.from('NEW=1\n').toString('base64'), mode: 0o644, mtimeMs: 1 }],
    }
    const result = applyWorkspaceSecretSlot(dir, payload)

    expect(result.written).toEqual(['.env'])
    expect(result.removed).toEqual(['.env.staging'])
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('NEW=1\n')
    // The mode in the payload is not trusted: a restored secret is 0600.
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600)
    // A non-secret file in the root is never touched.
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{}\n')
  })

  test('a slot with no files clears the stale copy (a deleted .env stays deleted)', () => {
    const dir = root()
    writeFileSync(join(dir, '.env'), 'SECRET=1\n')
    applyWorkspaceSecretSlot(dir, { slot: WORKSPACE_SECRET_SLOT_ROOT, files: [] })
    expect(() => readFileSync(join(dir, '.env'))).toThrow()
  })

  test('refuses a sibling path dressed up as a name instead of escaping the root', () => {
    const dir = root()
    mkdirSync(join(dir, 'nested'))
    const result = applyWorkspaceSecretSlot(dir, {
      slot: WORKSPACE_SECRET_SLOT_ROOT,
      files: [{ name: '../.env', content: Buffer.from('X=1').toString('base64'), mode: 0o600, mtimeMs: 0 }],
    })
    expect(result.written).toEqual([])
  })
})

describe('workspaceSecretsTag', () => {
  test('changes with a value, a name set, and the slot set', () => {
    const base = {
      version: WORKSPACE_ROOT_SECRETS_VERSION,
      slots: [
        {
          slot: WORKSPACE_SECRET_SLOT_ROOT,
          files: [{ name: '.env', content: Buffer.from('A=1').toString('base64'), mode: 0o600, mtimeMs: 0 }],
        },
      ],
    } as const
    const tag = workspaceSecretsTag(base as any)
    expect(workspaceSecretsTag(JSON.parse(JSON.stringify(base)) as any)).toBe(tag)
    expect(
      workspaceSecretsTag({
        ...base,
        slots: [{ ...base.slots[0], files: [{ ...base.slots[0]!.files[0], content: Buffer.from('A=2').toString('base64') }] }],
      } as any),
    ).not.toBe(tag)
    expect(workspaceSecretsTag({ version: WORKSPACE_ROOT_SECRETS_VERSION, slots: [] })).not.toBe(tag)
  })

  test('is stable across slot order, so a reordered payload is not an upload', () => {
    const a = { slot: 'a', files: [] }
    const b = { slot: 'b', files: [] }
    const one = workspaceSecretsTag({ version: WORKSPACE_ROOT_SECRETS_VERSION, slots: [a, b] } as any)
    const two = workspaceSecretsTag({ version: WORKSPACE_ROOT_SECRETS_VERSION, slots: [b, a] } as any)
    expect(one).toBe(two)
  })
})

describe('validateWorkspaceRootSecrets', () => {
  const valid = {
    version: WORKSPACE_ROOT_SECRETS_VERSION,
    slots: [
      {
        slot: WORKSPACE_SECRET_SLOT_ROOT,
        files: [{ name: '.env', content: Buffer.from('A=1').toString('base64'), mode: 0o600, mtimeMs: 0 }],
      },
    ],
  }

  test('accepts a well-formed payload, including an empty slot', () => {
    expect(validateWorkspaceRootSecrets(valid)).toBeNull()
    expect(validateWorkspaceRootSecrets(emptyWorkspaceRootSecrets([{ slot: WORKSPACE_SECRET_SLOT_ROOT }]))).toBeNull()
  })

  test('rejects a payload that would write a non-secret file', () => {
    const bad = JSON.parse(JSON.stringify(valid))
    bad.slots[0].files[0].name = 'MEMORY.md'
    expect(validateWorkspaceRootSecrets(bad)).toContain('non-secret file name')
  })

  test('rejects a slot that could escape the workspace', () => {
    for (const slot of ['../etc', 'a/b', '', '.hidden']) {
      const bad = JSON.parse(JSON.stringify(valid))
      bad.slots[0].slot = slot
      expect(validateWorkspaceRootSecrets(bad)).not.toBeNull()
    }
  })

  test('rejects an unknown version rather than half-applying it', () => {
    expect(validateWorkspaceRootSecrets({ ...valid, version: 2 })).toContain('unsupported payload version')
  })

  test('rejects a repeated name and a repeated slot', () => {
    const dupFile = JSON.parse(JSON.stringify(valid))
    dupFile.slots[0].files.push({ ...dupFile.slots[0].files[0] })
    expect(validateWorkspaceRootSecrets(dupFile)).toContain('repeats')

    const dupSlot = JSON.parse(JSON.stringify(valid))
    dupSlot.slots.push(JSON.parse(JSON.stringify(dupSlot.slots[0])))
    expect(validateWorkspaceRootSecrets(dupSlot)).toContain('duplicate slot')
  })
})

describe('workspaceRuntimeKey', () => {
  test('names the merged and the project-anchored runtimes differently', () => {
    expect(workspaceRuntimeKey({ workspaceId: 'w1' })).toBe('ws:w1')
    expect(workspaceRuntimeKey({ workspaceId: 'w1', anchorProjectId: 'p1' })).toBe('ws:proj:p1')
  })
})
