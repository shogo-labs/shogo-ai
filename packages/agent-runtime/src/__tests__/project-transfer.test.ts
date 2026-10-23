// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * project-transfer.ts (`copy_to_project`): pack on the caller, unpack on the
 * target, and the tool wiring between them. The target runtime is run
 * in-process behind a fake API; the two-runtime path is covered by
 * remote-tool-channel.integration.test.ts.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import {
  TRANSFER_MAX_ARCHIVE_BYTES,
  TransferError,
  executeRemoteImport,
  importArchive,
  packPaths,
} from '../project-transfer'
import { createTools, resetRemoteTargetCache, type ToolContext } from '../gateway-tools'
import { __resetTrustForTests } from '../trust-resolver'

const ENV_KEYS = [
  'WORKSPACE_DIR',
  'PROJECT_ID',
  'WORKSPACE_ID',
  'SHOGO_API_URL',
  'WORKSPACE_RUNTIME',
  'WORKSPACE_ANCHOR_PROJECT_ID',
  'WORKSPACE_AVAILABLE_PROJECTS',
  'SHOGO_RUNTIME_SUBSTRATE',
  'WORKSPACE_PROJECTS',
]

let saved: Record<string, string | undefined>
let base: string
let src: string
let dst: string

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

async function tar(args: string[], cwd: string): Promise<Buffer> {
  const proc = Bun.spawn(['tar', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, COPYFILE_DISABLE: '1' } })
  const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited])
  if (code !== 0) throw new Error(`tar ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`)
  return Buffer.from(out)
}

async function expectTransferError(promise: Promise<unknown>, status: number, code: string): Promise<TransferError> {
  const err = await promise.then(() => null, (e) => e)
  expect(err).toBeInstanceOf(TransferError)
  expect(err.status).toBe(status)
  expect(err.code).toBe(code)
  return err
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  __resetTrustForTests()
  base = mkdtempSync(join(tmpdir(), 'shogo-transfer-'))
  src = join(base, 'src')
  dst = join(base, 'dst')
  mkdirSync(src, { recursive: true })
  mkdirSync(dst, { recursive: true })
  // Env-fallback trust: both sides live under one allowed root.
  process.env.WORKSPACE_DIR = base
  delete process.env.WORKSPACE_RUNTIME
  delete process.env.SHOGO_RUNTIME_SUBSTRATE
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __resetTrustForTests()
  rmSync(base, { recursive: true, force: true })
})

describe('packPaths + importArchive', () => {
  test('round-trips binary files and nested folders, cp -r style, with a sha256 manifest', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x00])
    mkdirSync(join(src, 'site/public/cab2/img'), { recursive: true })
    writeFileSync(join(src, 'site/public/cab2/img/hero.png'), png)
    writeFileSync(join(src, 'site/public/cab2/data.json'), '{"ok":true}')
    writeFileSync(join(src, 'site/public/cab2/-leading-dash.txt'), 'dash')
    writeFileSync(join(src, 'notes.md'), '# notes')

    const packed = await packPaths(src, ['site/public/cab2', 'notes.md'])
    expect(packed.fileCount).toBe(4)
    expect(packed.skipped).toEqual([])

    const written: string[] = []
    const manifest = await importArchive(
      dst,
      { archive: packed.archive.toString('base64'), dest: 'public/assets' },
      (rel) => written.push(rel),
    )
    expect(manifest).toMatchObject({ ok: true, dest: 'public/assets', fileCount: 4 })
    expect(readFileSync(join(dst, 'public/assets/cab2/img/hero.png'))).toEqual(png)
    expect(readFileSync(join(dst, 'public/assets/cab2/data.json'), 'utf-8')).toBe('{"ok":true}')
    expect(readFileSync(join(dst, 'public/assets/notes.md'), 'utf-8')).toBe('# notes')
    const hero = manifest.files.find((f) => f.path === 'public/assets/cab2/img/hero.png')
    expect(hero).toEqual({ path: 'public/assets/cab2/img/hero.png', bytes: png.length, sha256: sha256(png) })
    expect(manifest.totalBytes).toBe(png.length + '{"ok":true}'.length + 'dash'.length + '# notes'.length)
    expect(written.sort()).toEqual(manifest.files.map((f) => f.path).sort())
    expect(readdirSync(join(dst, '.tmp'))).toEqual([])
  })

  test('"." copies the contents of the root; dest defaults to the target root', async () => {
    writeFileSync(join(src, 'a.txt'), 'a')
    mkdirSync(join(src, 'dir'))
    writeFileSync(join(src, 'dir/b.txt'), 'b')
    const packed = await packPaths(src, ['.'])
    const manifest = await importArchive(dst, { archive: packed.archive.toString('base64') })
    expect(manifest.dest).toBe('.')
    expect(manifest.files.map((f) => f.path).sort()).toEqual(['a.txt', 'dir/b.txt'])
  })

  test('skips symlinks, node_modules and .git rather than following them', async () => {
    mkdirSync(join(src, 'pack/node_modules/dep'), { recursive: true })
    mkdirSync(join(src, 'pack/.git'), { recursive: true })
    writeFileSync(join(src, 'pack/node_modules/dep/index.js'), 'x')
    writeFileSync(join(src, 'pack/.git/HEAD'), 'ref')
    writeFileSync(join(src, 'pack/keep.txt'), 'keep')
    symlinkSync('/etc/hosts', join(src, 'pack/escape'))
    const packed = await packPaths(src, ['pack'])
    expect(packed.fileCount).toBe(1)
    expect(packed.skipped.sort()).toEqual(['pack/.git', 'pack/escape', 'pack/node_modules'])
  })

  test('caller-side refusals: outside the root, missing, empty, duplicate names', async () => {
    writeFileSync(join(base, 'outside.txt'), 'x')
    await expectTransferError(packPaths(src, ['../outside.txt']), 400, 'outside_root')
    await expectTransferError(packPaths(src, ['nope']), 400, 'not_found')
    await expectTransferError(packPaths(src, []), 400, 'bad_request')
    mkdirSync(join(src, 'only-links'))
    symlinkSync('/etc/hosts', join(src, 'only-links/l'))
    await expectTransferError(packPaths(src, ['only-links']), 400, 'empty')
    mkdirSync(join(src, 'x'))
    mkdirSync(join(src, 'y'))
    writeFileSync(join(src, 'x/same.txt'), '1')
    writeFileSync(join(src, 'y/same.txt'), '2')
    await expectTransferError(packPaths(src, ['x/same.txt', 'y/same.txt']), 400, 'duplicate_entry')
  })

  test('refuses existing files unless overwrite, and writes nothing on conflict', async () => {
    writeFileSync(join(src, 'a.txt'), 'new')
    writeFileSync(join(src, 'b.txt'), 'new')
    writeFileSync(join(dst, 'a.txt'), 'old')
    const archive = (await packPaths(src, ['a.txt', 'b.txt'])).archive.toString('base64')

    const err = await expectTransferError(importArchive(dst, { archive }), 409, 'conflict')
    expect(err.extra.conflicts).toEqual(['a.txt'])
    expect(readFileSync(join(dst, 'a.txt'), 'utf-8')).toBe('old')
    expect(existsSync(join(dst, 'b.txt'))).toBe(false)

    const manifest = await importArchive(dst, { archive, overwrite: true })
    expect(manifest.fileCount).toBe(2)
    expect(readFileSync(join(dst, 'a.txt'), 'utf-8')).toBe('new')
  })

  test('rejects archives with symlinks, hardlinks, .. or absolute entries before writing anything', async () => {
    const craft = join(base, 'craft')
    mkdirSync(craft)
    writeFileSync(join(craft, 'a'), 'a')
    linkSync(join(craft, 'a'), join(craft, 'hard'))
    symlinkSync('/etc/hosts', join(craft, 'soft'))
    writeFileSync(join(base, 'up.txt'), 'up')

    const cases: Array<[string, Buffer]> = [
      ['symlink', await tar(['-czf', '-', 'soft'], craft)],
      ['hardlink', await tar(['-czf', '-', 'a', 'hard'], craft)],
      ['dotdot', await tar(['-czPf', '-', '../up.txt'], craft)],
      ['absolute', await tar(['-czPf', '-', join(base, 'up.txt')], craft)],
    ]
    for (const [, archive] of cases) {
      await expectTransferError(importArchive(dst, { archive: archive.toString('base64') }), 400, 'unsafe_archive')
    }
    expect(readdirSync(dst).filter((n) => n !== '.tmp')).toEqual([])
    expect(existsSync(join(base, 'hosts'))).toBe(false)
  })

  test('target-side refusals: bad body, dest escape, garbage archive, size cap', async () => {
    await expectTransferError(importArchive(dst, null), 400, 'bad_request')
    await expectTransferError(importArchive(dst, { archive: 'aGk=', dest: 7 }), 400, 'bad_request')
    await expectTransferError(importArchive(dst, { archive: 'aGk=', dest: '/etc' }), 400, 'bad_request')
    await expectTransferError(importArchive(dst, { archive: 'aGk=', dest: '../elsewhere' }), 400, 'outside_root')
    await expectTransferError(importArchive(dst, { archive: Buffer.from('not a tarball').toString('base64') }), 400, 'bad_archive')
    const huge = 'A'.repeat(Math.ceil((TRANSFER_MAX_ARCHIVE_BYTES * 4) / 3) + 8)
    await expectTransferError(importArchive(dst, { archive: huge }), 413, 'too_large')
  })

  test('a read-only target root refuses the import', async () => {
    writeFileSync(join(src, 'a.txt'), 'a')
    const archive = (await packPaths(src, ['a.txt'])).archive.toString('base64')
    const savedReadonly = process.env.READONLY_ROOTS
    process.env.READONLY_ROOTS = JSON.stringify([dst])
    try {
      await expectTransferError(importArchive(dst, { archive }), 403, 'readonly_root_write')
      expect(existsSync(join(dst, 'a.txt'))).toBe(false)
    } finally {
      if (savedReadonly === undefined) delete process.env.READONLY_ROOTS
      else process.env.READONLY_ROOTS = savedReadonly
    }
  })

  test('executeRemoteImport maps errors to status + API-shaped error bodies and never throws', async () => {
    expect(await executeRemoteImport(dst, null)).toEqual({
      status: 400,
      body: { ok: false, error: { code: 'bad_request', message: 'Missing required field: archive (base64 tar.gz)' } },
    })
    writeFileSync(join(src, 'a.txt'), 'a')
    writeFileSync(join(dst, 'a.txt'), 'old')
    const archive = (await packPaths(src, ['a.txt'])).archive.toString('base64')
    const conflict = await executeRemoteImport(dst, { archive })
    expect(conflict.status).toBe(409)
    expect(conflict.body).toMatchObject({ ok: false, error: { code: 'conflict' }, conflicts: ['a.txt'] })
  })
})

describe('copy_to_project tool and the other-project guardrail (metal workspace agent)', () => {
  const WORKSPACE_ID = 'ws-transfer'
  const STUDIO = '11111111-1111-4111-8111-111111111111'
  const OTHER = '22222222-2222-4222-8222-222222222222'
  const GRAPH = [
    { id: STUDIO, name: 'Studio', description: null, workingMode: 'managed', settings: {}, attachments: [], agent: null },
    { id: OTHER, name: 'Cab Site', description: null, workingMode: 'managed', settings: {}, attachments: [], agent: null },
  ]
  const originalFetch = globalThis.fetch
  let imports: Array<{ url: string; body: any }>
  let targetRoot: string

  function workspaceAgentEnv(): void {
    process.env.WORKSPACE_RUNTIME = 'true'
    process.env.SHOGO_RUNTIME_SUBSTRATE = 'metal'
    process.env.WORKSPACE_ID = WORKSPACE_ID
    delete process.env.WORKSPACE_ANCHOR_PROJECT_ID
    delete process.env.PROJECT_ID
    process.env.WORKSPACE_AVAILABLE_PROJECTS = JSON.stringify(GRAPH.map(({ id, name }) => ({ id, name })))
    process.env.SHOGO_API_URL = 'http://api.test'
  }

  function anchorTo(projectId: string): void {
    process.env.WORKSPACE_ANCHOR_PROJECT_ID = projectId
    process.env.PROJECT_ID = projectId
  }

  function tools(): AgentTool[] {
    const ctx: ToolContext = {
      workspaceDir: src,
      channels: new Map(),
      config: {} as any,
      projectId: process.env.PROJECT_ID ?? '',
      workspaceId: WORKSPACE_ID,
    }
    return createTools(ctx)
  }

  function tool(name: string): AgentTool {
    const found = tools().find((t) => t.name === name)
    if (!found) throw new Error(`tool ${name} not registered`)
    return found
  }

  beforeEach(() => {
    workspaceAgentEnv()
    // The trust root is the merged workspace root the tools run in, as in production.
    process.env.WORKSPACE_DIR = src
    resetRemoteTargetCache()
    imports = []
    targetRoot = join(src, 'target-project')
    mkdirSync(targetRoot, { recursive: true })
    mkdirSync(join(src, 'drafts/public/cab2'), { recursive: true })
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith(`/workspaces/${WORKSPACE_ID}/projects/graph`)) return Response.json({ projects: GRAPH })
      if (url.endsWith(`/projects/${OTHER}/files/import`)) {
        const body = JSON.parse(String(init?.body))
        imports.push({ url, body })
        const outcome = await executeRemoteImport(targetRoot, body)
        return Response.json(outcome.body, { status: outcome.status })
      }
      return Response.json({ error: { code: 'not_found', message: url } }, { status: 404 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    resetRemoteTargetCache()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  test('registered only for the workspace agent on metal', () => {
    expect(tools().some((t) => t.name === 'copy_to_project')).toBe(true)
    anchorTo(STUDIO)
    expect(tools().some((t) => t.name === 'copy_to_project')).toBe(false)
    workspaceAgentEnv()
    process.env.SHOGO_RUNTIME_SUBSTRATE = 'k8s'
    expect(tools().some((t) => t.name === 'copy_to_project')).toBe(false)
    process.env.SHOGO_RUNTIME_SUBSTRATE = 'metal'
    delete process.env.WORKSPACE_RUNTIME
    expect(tools().some((t) => t.name === 'copy_to_project')).toBe(false)
  })

  test('copies a folder into the other project by name and returns the manifest', async () => {
    writeFileSync(join(src, 'drafts/public/cab2/data.json'), '{"cab":2}')
    writeFileSync(join(src, 'drafts/public/cab2/logo.png'), Buffer.from([1, 2, 3, 0, 255]))
    const result = await tool('copy_to_project').execute('c1', {
      project: 'Cab Site',
      paths: ['drafts/public/cab2'],
      dest: 'public/assets',
    })
    const details = result.details as any
    expect(details).toMatchObject({ ok: true, project: { id: OTHER, name: 'Cab Site' }, dest: 'public/assets', fileCount: 2 })
    expect(details.files.map((f: any) => f.path).sort()).toEqual(['public/assets/cab2/data.json', 'public/assets/cab2/logo.png'])
    expect(readFileSync(join(targetRoot, 'public/assets/cab2/logo.png'))).toEqual(Buffer.from([1, 2, 3, 0, 255]))
    expect(imports).toHaveLength(1)
    expect(imports[0]!.body).toMatchObject({ dest: 'public/assets' })
    expect(imports[0]!.body.overwrite).toBeUndefined()
  })

  test('surfaces target conflicts with the conflicting paths', async () => {
    writeFileSync(join(src, 'drafts/public/cab2/data.json'), 'new')
    mkdirSync(join(targetRoot, 'cab2'), { recursive: true })
    writeFileSync(join(targetRoot, 'cab2/data.json'), 'old')
    const result = await tool('copy_to_project').execute('c2', { project: OTHER, paths: ['drafts/public/cab2'] })
    expect(result.details).toMatchObject({ code: 'conflict', status: 409, conflicts: ['cab2/data.json'] })
    expect(readFileSync(join(targetRoot, 'cab2/data.json'), 'utf-8')).toBe('old')
  })

  test('caller-side errors do not call the API', async () => {
    const missing = await tool('copy_to_project').execute('c4', { project: OTHER, paths: ['nope'] })
    expect(missing.details).toMatchObject({ code: 'not_found', project: { id: OTHER } })
    expect(imports).toEqual([])
  })

  test('write_file and read_file into a project folder are refused with the fix', async () => {
    const write = await tool('write_file').execute('w1', { path: `${OTHER}/CAB_PLAN.md`, content: 'plan' })
    expect((write.details as any).error).toContain('copy_to_project')
    expect(existsSync(join(src, OTHER))).toBe(false)
    mkdirSync(join(src, OTHER))
    writeFileSync(join(src, OTHER, 'stale.md'), 'stale')
    const read = await tool('read_file').execute('r1', { path: `${OTHER}/stale.md` })
    expect((read.details as any).error).toContain(`project: "${OTHER}"`)
    const plainWrite = await tool('write_file').execute('w2', { path: 'drafts/ok.md', content: 'ok' })
    expect((plainWrite.details as any).error).toBeUndefined()
  })

  test('an anchored workspace runtime is refused too, pointed at project: instead of copy_to_project', async () => {
    anchorTo(STUDIO)
    const write = await tool('write_file').execute('w3', { path: `${OTHER}/CAB_PLAN.md`, content: 'plan' })
    const error = (write.details as any).error as string
    expect(error).toContain(`project: "${OTHER}"`)
    expect(error).not.toContain('copy_to_project')
    const anchorWrite = await tool('write_file').execute('w4', { path: `${STUDIO}/ok.md`, content: 'ok' })
    expect((anchorWrite.details as any).error).toBeUndefined()
  })

  test('exec that creates a folder named after another project gets a warning', async () => {
    const result = await tool('exec').execute('e1', { command: `mkdir -p ${OTHER}/public && echo made` })
    const details = result.details as any
    expect(details.stdout).toBe('made')
    expect(details.warning).toContain(`\`${OTHER}/\``)
    expect(details.warning).toContain('copy_to_project')
    const plain = await tool('exec').execute('e2', { command: 'mkdir -p scratch && echo ok' })
    expect((plain.details as any).warning).toBeUndefined()
  })
})
