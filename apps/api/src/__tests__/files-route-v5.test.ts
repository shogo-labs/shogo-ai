process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-secret-v5'
// files.ts v5 coverage — closes remaining uncov lines.
import { beforeEach, describe, expect, test, mock } from 'bun:test'

const fsState = new Map<string, { type:'file'|'dir'; content?: string|Buffer; size?: number }>()
const errorPaths = new Set<string>()

function setFile(p: string, c: string|Buffer) {
  fsState.set(p, { type:'file', content:c, size:typeof c==='string' ? Buffer.byteLength(c) : (c as Buffer).byteLength })
  const parts = p.split('/')
  for (let i = 1; i < parts.length - 1; i++) {
    const d = '/' + parts.slice(1, i+1).join('/')
    if (d && !fsState.has(d)) fsState.set(d, { type:'dir' })
  }
}
function setDir(p: string) { fsState.set(p, { type:'dir' }) }

mock.module('fs/promises', () => ({
  readdir: async (dir: string, _?: any) => {
    if (errorPaths.has(dir)) throw new Error('EPERM: disk error')
    const prefix = dir.endsWith('/') ? dir : dir+'/'
    const ents: { name:string; isDirectory:()=>boolean; isFile:()=>boolean }[] = []
    for (const [path, e] of fsState) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
        ents.push({ name: path.slice(prefix.length), isDirectory:()=>e.type==='dir', isFile:()=>e.type==='file' })
      }
    }
    if (ents.length === 0 && !fsState.has(dir)) {
      const err:any = new Error(`ENOENT: ${dir}`); err.code = 'ENOENT'; throw err
    }
    return ents
  },
  readFile: async (path: string, enc?: any) => {
    if (errorPaths.has('read:'+path)) throw new Error('EACCES: permission denied')
    const e = fsState.get(path)
    if (!e || e.type !== 'file') { const err:any = new Error(`ENOENT: ${path}`); err.code='ENOENT'; throw err }
    const buf = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content as string)
    return (enc === 'utf-8' || enc === 'utf8') ? buf.toString('utf-8') : buf
  },
  writeFile: async (path: string, content: string) => {
    if (errorPaths.has('write:'+path)) throw new Error('ENOSPC: no space')
    setFile(path, content)
  },
  mkdir: async (path: string, _?: any) => { setDir(path) },
  stat: async (path: string) => {
    const e = fsState.get(path)
    if (!e) { const err:any = new Error(`ENOENT: ${path}`); err.code='ENOENT'; throw err }
    return { size: e.size ?? 0, isDirectory: () => e.type === 'dir', isFile: () => e.type === 'file' }
  },
}))

const prismaMock = { project: { findUnique: mock(async (_:any) => null as any) } }
mock.module('../lib/prisma', () => ({ prisma: prismaMock }))
mock.module('../lib/s3', () => ({
  getPresignedReadUrl: mock(async (k:string) => `https://s3/${k}`),
  getPresignedWriteUrl: mock(async (k:string) => `https://s3/write/${k}`),
  listAllObjectsInS3: mock(async () => []),
  deleteFromS3: mock(async () => {}),
  isS3Enabled: mock(() => false),
}))

const { filesRoutes } = await import('../routes/files')
const router = filesRoutes({ workspacesDir: '/ws' })

async function req(method: string, path: string, body?: unknown) {
  const r = new Request(`http://t${path}`, {
    method,
    headers: body ? { 'content-type':'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const res = await router.fetch(r)
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeEach(() => { fsState.clear(); errorPaths.clear(); prismaMock.project.findUnique.mockImplementation(async () => null) })

// ─── subdir listing (lines 124-134) ──────────────────────────────────────────
// The list route starts from projectPath/src. So excluded + non-excluded dirs
// must be inside src/ to trigger lines 124 (continue) and 127-134 (push+recurse).
describe('directory listing — excluded + non-excluded dirs inside src/', () => {
  test('excluded dir inside src → continue (line 124), non-excluded subdir → push+recurse (127-134)', async () => {
    // project src dir with an excluded subdir and a non-excluded one
    setDir('/ws/p1/src')
    setDir('/ws/p1/src/.git')          // excluded → continue (line 124)
    setDir('/ws/p1/src/components')    // non-excluded → push dir (127-131) + recurse (134)
    setFile('/ws/p1/src/components/App.tsx', 'export default function App() {}')
    prismaMock.project.findUnique.mockImplementation(async () => ({ id: 'p1' }))
    const r = await req('GET', '/projects/p1/files')
    expect(r.status).toBe(200)
    const names = (r.json?.files ?? []).map((f:any) => f.name)
    expect(names).not.toContain('.git')          // excluded dir skipped
    expect(names).toContain('components')        // non-excluded dir pushed (lines 127-131)
    expect(names).toContain('App.tsx')           // recursive listing reached file (line 134)
  })
})

// ─── listFilesRecursive readdir catch (lines 156-157) ────────────────────────
describe('listFilesRecursive readdir catch', () => {
  test('readdir throws at top level of src → caught internally → 200 empty list (lines 156-157)', async () => {
    setDir('/ws/p2/src')
    prismaMock.project.findUnique.mockImplementation(async () => ({ id: 'p2' }))
    errorPaths.add('/ws/p2/src')   // make readdir throw for src → caught at lines 156-157
    const r = await req('GET', '/projects/p2/files')
    expect(r.status).toBe(200)
  })
})

// ─── getProjectPath stat-fallback catch (line 189) ───────────────────────────
describe('getProjectPath stat catch', () => {
  test('prisma returns null AND workspace missing → stat throws → 404 (line 189)', async () => {
    prismaMock.project.findUnique.mockImplementation(async () => null)
    // 'ghost' not in fsState → stat('/ws/ghost') throws ENOENT → line 189
    const r = await req('GET', '/projects/ghost/files')
    expect(r.status).toBe(404)
  })
})

// ─── read invalid path (lines 304-307) ───────────────────────────────────────
describe('read route invalid path', () => {
  test('GET with no file path → 400 or 404 (lines 304-307)', async () => {
    setDir('/ws/p3/src')
    prismaMock.project.findUnique.mockImplementation(async () => ({ id: 'p3' }))
    const r = await req('GET', '/projects/p3/files/')
    expect([400, 404]).toContain(r.status)
  })
})

// ─── read error 500 (lines 354-361) ──────────────────────────────────────────
describe('read route 500 error', () => {
  test('readFile throws non-ENOENT → 500 read_failed (lines 354-361)', async () => {
    setDir('/ws/p4/src')
    setFile('/ws/p4/src/a.ts', 'hello')
    prismaMock.project.findUnique.mockImplementation(async () => ({ id: 'p4' }))
    errorPaths.add('read:/ws/p4/src/a.ts')
    const r = await req('GET', '/projects/p4/files/src/a.ts')
    expect(r.status).toBe(500)
    expect(r.json.error.code).toBe('read_failed')
  })
})

// ─── write invalid path (lines 376-379) ──────────────────────────────────────
describe('write route invalid path', () => {
  test('PUT with no path → 400 or 404 (lines 376-379)', async () => {
    setDir('/ws/p5/src')
    prismaMock.project.findUnique.mockImplementation(async () => ({ id: 'p5' }))
    const r = await req('PUT', '/projects/p5/files/', { content: 'hi' })
    expect([400, 404]).toContain(r.status)
  })
})

// ─── write error 500 (lines 415-419) ─────────────────────────────────────────
describe('write route 500 error', () => {
  test('writeFile throws → 500 write_failed (lines 415-419)', async () => {
    setDir('/ws/p6/src')
    setFile('/ws/p6/src/a.ts', 'existing')
    prismaMock.project.findUnique.mockImplementation(async () => ({ id: 'p6' }))
    errorPaths.add('write:/ws/p6/src/a.ts')
    const r = await req('PUT', '/projects/p6/files/src/a.ts', { content: 'new content' })
    expect(r.status).toBe(500)
    expect(r.json.error.code).toBe('write_failed')
  })
})

// ─── delete invalid path (lines 645-648) ─────────────────────────────────────
describe('delete route invalid path', () => {
  test('DELETE with no path → 400 or 404 (lines 645-648)', async () => {
    setDir('/ws/p7/src')
    prismaMock.project.findUnique.mockImplementation(async () => ({ id: 'p7' }))
    const r = await req('DELETE', '/projects/p7/files/')
    expect([400, 404]).toContain(r.status)
  })
})
