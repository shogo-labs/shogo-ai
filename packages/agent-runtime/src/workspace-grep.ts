// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Server-side full-text search for the IDE's Search view.
//
// The old client implementation downloaded up to 600 files over HTTP and
// grepped them in the browser. This does the work next to the files instead:
// ripgrep when it is on PATH (fast, honours .gitignore), otherwise a bounded
// JS walker over the same tree the Explorer shows.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { isBinaryFilePath } from '@shogo-ai/sdk/file-types'
import {
  WORKSPACE_TREE_HIDDEN_DIRS,
  WORKSPACE_TREE_LAZY_DIRS,
  walkFilesTree,
  type WorkspaceTreeNode,
} from './fs-tree-walker'

export interface GrepRequest {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  /** Comma separated include globs / folders (VS Code "files to include"). */
  include?: string
  /** Comma separated exclude globs / folders. */
  exclude?: string
  /** Max total matches returned. Default 500, hard cap 5000. */
  limit?: number
  /** Max matches reported per file. Default 50. */
  maxPerFile?: number
}

export interface GrepMatch {
  line: number
  col: number
  preview: string
}

export interface GrepResponse {
  results: Array<{ path: string; matches: GrepMatch[] }>
  truncated: boolean
  engine: 'ripgrep' | 'js'
}

export class GrepError extends Error {}

const MAX_FILE_BYTES = 1024 * 1024
const PREVIEW_CHARS = 240
const JS_MAX_FILES = 20_000

// ---------------------------------------------------------------------------
// Glob list matching (same syntax as apps/mobile .../ide/workspace/glob.ts)
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, '\\$&')
}

function globToSource(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end > i) {
        out += `(?:${glob.slice(i + 1, end).split(',').map(globToSource).join('|')})`
        i = end
      } else out += '\\{'
    } else out += escapeRe(c)
  }
  return out
}

function compileOne(raw: string): ((path: string) => boolean) | null {
  let p = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!p) return null
  const hasGlob = /[*?{]/.test(p)
  const hasSlash = p.includes('/')
  if (!hasGlob) {
    const anchored = p.replace(/^\//, '')
    if (hasSlash || p.startsWith('/')) {
      return (path) => path === anchored || path.startsWith(`${anchored}/`)
    }
    return (path) => path.split('/').includes(p)
  }
  const src = globToSource(p.replace(/^\//, ''))
  if (hasSlash) {
    const re = new RegExp(`^${src}(?:/.*)?$`)
    return (path) => re.test(path)
  }
  const re = new RegExp(`^${src}$`)
  return (path) => path.split('/').some((s) => re.test(s))
}

export function compileGlobList(spec: string | undefined): ((path: string) => boolean) | null {
  if (!spec || !spec.trim()) return null
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of spec) {
    if (ch === '{') depth++
    if (ch === '}') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  const ms = parts.map(compileOne).filter((m): m is (path: string) => boolean => m !== null)
  return ms.length ? (path) => ms.some((m) => m(path)) : null
}

function buildFilter(req: GrepRequest): (path: string) => boolean {
  const inc = compileGlobList(req.include)
  const exc = compileGlobList(req.exclude)
  return (path) => (!inc || inc(path)) && !(exc && exc(path))
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

function buildRegExp(req: GrepRequest): RegExp {
  const flags = req.caseSensitive ? 'g' : 'gi'
  try {
    return new RegExp(req.regex ? req.query : req.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  } catch {
    throw new GrepError('Invalid regex')
  }
}

function clip(line: string): string {
  return line.length > PREVIEW_CHARS ? line.slice(0, PREVIEW_CHARS) : line
}

// ---------------------------------------------------------------------------
// ripgrep engine
// ---------------------------------------------------------------------------

let rgPath: string | null | undefined

export function resolveRipgrep(): string | null {
  if (rgPath !== undefined) return rgPath
  const fromEnv = process.env.SHOGO_RG_PATH
  if (fromEnv && existsSync(fromEnv)) return (rgPath = fromEnv)
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg'
  for (const d of dirs) {
    if (d && existsSync(join(d, exe))) return (rgPath = join(d, exe))
  }
  return (rgPath = null)
}

/** Test hook: forget the cached ripgrep lookup. */
export function __resetRipgrepCache(): void {
  rgPath = undefined
}

function grepWithRipgrep(
  rg: string,
  root: string,
  req: GrepRequest,
  limit: number,
  maxPerFile: number,
  filter: (path: string) => boolean,
): Promise<GrepResponse> {
  const args = [
    '--json',
    '--hidden',
    '--no-require-git',
    '--max-filesize', '1M',
    '--max-count', String(maxPerFile),
    req.caseSensitive ? '--case-sensitive' : '--ignore-case',
  ]
  if (!req.regex) args.push('--fixed-strings')
  for (const d of WORKSPACE_TREE_HIDDEN_DIRS) args.push('--glob', `!${d}`)
  for (const d of WORKSPACE_TREE_LAZY_DIRS) args.push('--glob', `!${d}`)
  if (existsSync(join(root, '.shogoignore'))) args.push('--ignore-file', join(root, '.shogoignore'))
  args.push('-e', req.query, '--', '.')

  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    const byFile = new Map<string, GrepMatch[]>()
    const order: string[] = []
    let total = 0
    let truncated = false
    let stderr = ''
    let buf = ''
    let killed = false

    const finish = () => {
      resolve({
        results: order.map((path) => ({ path, matches: byFile.get(path)! })),
        truncated,
        engine: 'ripgrep',
      })
    }

    const onLine = (raw: string) => {
      if (!raw || killed) return
      let evt: any
      try { evt = JSON.parse(raw) } catch { return }
      if (evt.type !== 'match') return
      const data = evt.data
      let path: string = data.path?.text ?? ''
      if (!path) return
      path = path.replace(/^\.\//, '').replace(/\\/g, '/')
      if (!filter(path)) return
      const text: string = (data.lines?.text ?? '').replace(/\r?\n$/, '')
      const start: number = data.submatches?.[0]?.start ?? 0
      // `start` is a UTF-8 byte offset; Monaco wants a UTF-16 column.
      const col = Buffer.from(text, 'utf8').subarray(0, start).toString('utf8').length + 1
      let list = byFile.get(path)
      if (!list) {
        list = []
        byFile.set(path, list)
        order.push(path)
      }
      list.push({ line: data.line_number, col, preview: clip(text) })
      total++
      if (total >= limit) {
        truncated = true
        killed = true
        child.kill()
      }
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (c: string) => { if (stderr.length < 4000) stderr += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (buf) onLine(buf)
      if (killed || code === 0 || code === 1) return finish()
      if (/regex parse error|error parsing|regex/i.test(stderr)) {
        return reject(new GrepError('Invalid regex'))
      }
      reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`))
    })
  })
}

// ---------------------------------------------------------------------------
// JS fallback engine
// ---------------------------------------------------------------------------

function collectFiles(nodes: WorkspaceTreeNode[], out: string[]): void {
  for (const n of nodes) {
    if (out.length >= JS_MAX_FILES) return
    if (n.ignored) continue
    if (n.type === 'directory') {
      if (n.lazy) continue
      collectFiles(n.children ?? [], out)
    } else if (!isBinaryFilePath(n.path) && (n.size ?? 0) <= MAX_FILE_BYTES) {
      out.push(n.path)
    }
  }
}

async function grepWithJs(
  root: string,
  req: GrepRequest,
  limit: number,
  maxPerFile: number,
  filter: (path: string) => boolean,
): Promise<GrepResponse> {
  const re = buildRegExp(req)
  const tree = await walkFilesTree(root, root, {
    hiddenDirs: WORKSPACE_TREE_HIDDEN_DIRS,
    lazyDirs: WORKSPACE_TREE_LAZY_DIRS,
  })
  const files: string[] = []
  collectFiles(tree, files)
  const candidates = files.filter(filter)

  const results: GrepResponse['results'] = []
  let total = 0
  let truncated = files.length >= JS_MAX_FILES
  let idx = 0
  const workers = Array.from({ length: 8 }, async () => {
    while (total < limit) {
      const i = idx++
      if (i >= candidates.length) return
      const rel = candidates[i]
      let content: string
      try { content = await fsp.readFile(join(root, rel), 'utf8') } catch { continue }
      if (content.includes('\0')) continue
      const lines = content.split('\n')
      const matches: GrepMatch[] = []
      for (let ln = 0; ln < lines.length && matches.length < maxPerFile; ln++) {
        re.lastIndex = 0
        const m = re.exec(lines[ln])
        if (m) {
          matches.push({ line: ln + 1, col: m.index + 1, preview: clip(lines[ln].replace(/\r$/, '')) })
          total++
          if (total >= limit) break
        }
      }
      if (matches.length) results.push({ path: rel, matches })
    }
  })
  await Promise.all(workers)
  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  // Workers race past the limit while awaiting reads; trim to the exact cap.
  let kept = 0
  const trimmed: GrepResponse['results'] = []
  for (const r of results) {
    if (kept >= limit) break
    const matches = r.matches.slice(0, limit - kept)
    kept += matches.length
    trimmed.push({ path: r.path, matches })
  }
  if (total >= limit) truncated = true
  return { results: trimmed, truncated, engine: 'js' }
}

// ---------------------------------------------------------------------------

export async function grepWorkspace(
  root: string,
  req: GrepRequest,
  opts: { engine?: 'auto' | 'js' } = {},
): Promise<GrepResponse> {
  if (!req.query) return { results: [], truncated: false, engine: 'js' }
  const limit = Math.max(1, Math.min(req.limit ?? 500, 5000))
  const maxPerFile = Math.max(1, Math.min(req.maxPerFile ?? 50, 500))
  const filter = buildFilter(req)
  // Validate the pattern up front so both engines report the same error.
  buildRegExp(req)
  const rg = opts.engine === 'js' ? null : resolveRipgrep()
  if (rg) {
    try {
      return await grepWithRipgrep(rg, root, req, limit, maxPerFile, filter)
    } catch (err) {
      if (err instanceof GrepError) throw err
      // Binary vanished / failed to spawn → fall through to the JS engine.
    }
  }
  return grepWithJs(root, req, limit, maxPerFile, filter)
}
