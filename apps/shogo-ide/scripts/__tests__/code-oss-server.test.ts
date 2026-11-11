// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SERVER_INPUTS,
  SERVER_TARGETS,
  SHOGO_IDE_ROOT,
  assetFileName,
  computeArtifactId,
  computeInputsHash,
  readCodeOssLock,
} from '../code-oss-artifact-id.mjs'
import { applyProductOverrides } from '../apply-product-overrides.mjs'
import { findMarkers, pathsOverBudget, walkFiles, MAX_ARCHIVE_PATH } from '../build-code-oss-server.mjs'
import { buildManifest, parseSha256Sidecar, releaseAssetUrl } from '../write-code-oss-server-manifest.mjs'

const scratch = mkdtempSync(join(tmpdir(), 'shogo-ide-server-scripts-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** A copy of every hashed input, so tests can mutate it. */
function copyInputs(name: string): string {
  const root = join(scratch, name)
  for (const rel of SERVER_INPUTS) {
    cpSync(join(SHOGO_IDE_ROOT, rel), join(root, rel), { recursive: true })
  }
  return root
}

describe('code-oss.lock.json', () => {
  test('pins a full commit that the patches were rebased onto', () => {
    const lock = readCodeOssLock()
    expect(lock.commit).toBe('0feedbf3d9bac4e27e50d5475fe45336a67fbd7b')
    expect(lock.repo).toBe('https://github.com/microsoft/vscode.git')
  })
})

describe('artifact id', () => {
  test('is the commit prefix plus an inputs-hash prefix', () => {
    const id = computeArtifactId()
    expect(id.artifactId).toBe(`shogo-ide-server-${id.commit.slice(0, 12)}-${id.inputsHash.slice(0, 12)}`)
    expect(id.inputsHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('is stable across copies and line endings', () => {
    const a = copyInputs('stable-a')
    const b = copyInputs('stable-b')
    const patch = join(b, 'patches', 'code-oss', 'remove-built-in-chat.patch')
    writeFileSync(patch, readFileSync(patch, 'utf8').replace(/\n/g, '\r\n'))
    expect(computeInputsHash(a)).toBe(computeInputsHash(SHOGO_IDE_ROOT))
    expect(computeInputsHash(b)).toBe(computeInputsHash(a))
  })

  test.each([
    ['a patch', 'patches/code-oss/remove-built-in-chat.patch'],
    ['the product template', 'product.shogo.template.json'],
    ['shogo-core source', 'extensions/shogo-core/src/extension.ts'],
    ['the build script', 'scripts/build-code-oss-server.mjs'],
  ])('changes when %s changes', (_label, rel) => {
    const root = copyInputs(`change-${rel.replace(/\W/g, '-')}`)
    const before = computeInputsHash(root)
    writeFileSync(join(root, rel), `${readFileSync(join(root, rel), 'utf8')}\n// changed\n`)
    expect(computeInputsHash(root)).not.toBe(before)
  })

  test('ignores shogo-core tests and build output', () => {
    const root = copyInputs('ignored')
    const before = computeInputsHash(root)
    mkdirSync(join(root, 'extensions/shogo-core/dist'), { recursive: true })
    writeFileSync(join(root, 'extensions/shogo-core/dist/extension.js'), 'built')
    mkdirSync(join(root, 'extensions/shogo-core/src/__tests__'), { recursive: true })
    writeFileSync(join(root, 'extensions/shogo-core/src/__tests__/new.test.ts'), 'test')
    expect(computeInputsHash(root)).toBe(before)
  })

  test('asset names carry the target', () => {
    expect(assetFileName('shogo-ide-server-abc-def', 'win32-x64')).toBe('shogo-ide-server-abc-def-win32-x64.tar.gz')
    expect(SERVER_TARGETS).toEqual(['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'])
  })
})

describe('applyProductOverrides', () => {
  const upstream = {
    nameShort: 'Code - OSS',
    applicationName: 'code-oss',
    builtInExtensions: [{ name: 'ms-vscode.js-debug' }],
    defaultChatAgent: { extensionId: 'GitHub.copilot' },
    trustedExtensionAuthAccess: ['GitHub.copilot-chat'],
    builtInExtensionsEnabledWithAutoUpdates: ['GitHub.copilot-chat', 'ms-python.python'],
    untouched: 1,
  }
  const generated = JSON.parse(readFileSync(join(SHOGO_IDE_ROOT, 'distribution', 'generated', 'product.json'), 'utf8'))

  test('applies Shogo identity and strips Microsoft built-ins and Copilot', () => {
    const next = applyProductOverrides(upstream, generated)
    expect(next.nameShort).toBe('Shogo')
    expect(next.applicationName).toBe('shogo-ide')
    expect(next.builtInExtensions).toEqual([])
    expect(next.defaultChatAgent).toBeUndefined()
    expect(next.trustedExtensionAuthAccess).toBeUndefined()
    expect(next.builtInExtensionsEnabledWithAutoUpdates).toEqual(['ms-python.python'])
    expect(next.untouched).toBe(1)
    expect(next.extensionEnabledApiProposals['shogo.shogo-core']).toBeDefined()
  })

  test('does not mutate its input', () => {
    const copy = structuredClone(upstream)
    applyProductOverrides(copy, generated)
    expect(copy).toEqual(upstream)
  })
})

describe('build helpers', () => {
  test('pathsOverBudget lists only paths longer than the Windows budget, longest first', () => {
    const ok = 'a'.repeat(MAX_ARCHIVE_PATH)
    const long = 'b'.repeat(MAX_ARCHIVE_PATH + 1)
    const longer = 'c'.repeat(MAX_ARCHIVE_PATH + 5)
    expect(pathsOverBudget([ok, long, longer])).toEqual([longer, long])
  })

  test('walkFiles returns POSIX relative paths; findMarkers reports what is missing', () => {
    const dir = join(scratch, 'markers')
    mkdirSync(join(dir, 'vs', 'workbench'), { recursive: true })
    writeFileSync(join(dir, 'vs', 'workbench', 'main.js'), 'x.classList.add("shogo-chat-drop-active")')
    writeFileSync(join(dir, 'notes.txt'), 'shogo.context.addUris')
    expect(walkFiles(dir).sort()).toEqual(['notes.txt', 'vs/workbench/main.js'])
    expect(findMarkers(dir)).toEqual(['shogo.context.addUris'])
  })
})

describe('manifest writer', () => {
  test('builds a manifest from archives and sidecars', () => {
    const dir = join(scratch, 'artifacts')
    mkdirSync(dir, { recursive: true })
    const id = { artifactId: 'shogo-ide-server-aaa-bbb', commit: 'c'.repeat(40), inputsHash: 'd'.repeat(64) }
    for (const target of ['win32-x64', 'linux-x64']) {
      const file = assetFileName(id.artifactId, target)
      writeFileSync(join(dir, file), `archive-${target}`)
      writeFileSync(join(dir, `${file}.sha256`), `${'e'.repeat(64)}  ${file}\n`)
    }
    const manifest = buildManifest({ dir, repo: 'shogo-labs/shogo-ai', id, targets: ['win32-x64', 'linux-x64'] })
    expect(manifest.artifactId).toBe(id.artifactId)
    expect(manifest.assets['win32-x64']).toEqual({
      file: 'shogo-ide-server-aaa-bbb-win32-x64.tar.gz',
      url: releaseAssetUrl('shogo-labs/shogo-ai', id.artifactId, 'shogo-ide-server-aaa-bbb-win32-x64.tar.gz'),
      sha256: 'e'.repeat(64),
      size: 'archive-win32-x64'.length,
    })
  })

  test('rejects a malformed sidecar', () => {
    expect(() => parseSha256Sidecar('not-a-hash  file')).toThrow()
    expect(parseSha256Sidecar(`${'A'.repeat(64)}  f.tar.gz\n`)).toBe('a'.repeat(64))
  })
})
