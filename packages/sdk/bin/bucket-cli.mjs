#!/usr/bin/env node
/**
 * `shogo bucket` — the agent's handle on its project's bucket (SHO-491).
 *
 *   shogo bucket put <path…> [--key <key>] [--prefix <p>] [--private] [--overwrite]
 *   shogo bucket ls [prefix] [--private] [--json]
 *   shogo bucket rm <key…> [--private]
 *   shogo bucket url <key> [--private] [--signed] [--expires 3600]
 *   shogo bucket usage [--json]
 *   shogo bucket offload <dir> [--min-size 5MB] [--prefix <p>] [--private] [--dry-run]
 *
 * Credentials come from the pod's env, exactly like `shogo generate`:
 * `SHOGO_API_URL`, `PROJECT_ID`, `RUNTIME_AUTH_SECRET` (or `SHOGO_API_KEY`).
 *
 * The CLI never rewrites code. `offload` uploads and prints a manifest
 * (`{ path: url }`); the agent then rewrites the references and removes or
 * git-ignores the originals.
 *
 * Every failure prints the API's own `code` and `message` — a
 * `bucket_payment_required` answer includes the reason, the used/allowance
 * numbers and the Billing link, and the agent should relay them, not retry.
 */

import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'

const MB = 1024 * 1024
const MULTIPART_THRESHOLD = 64 * MB
const MULTIPART_PART_SIZE = 16 * MB

const USAGE = `
shogo bucket — this project's Shogo-hosted object storage + CDN

Usage:
  shogo bucket put <path…> [--key <key>] [--prefix <p>] [--private] [--overwrite]
  shogo bucket ls [prefix] [--private] [--json]
  shogo bucket rm <key…> [--private]
  shogo bucket url <key> [--private] [--signed] [--expires 3600]
  shogo bucket usage [--json]
  shogo bucket offload <dir> [--min-size 5MB] [--prefix <p>] [--private] [--dry-run]

Public objects are served from the CDN; private ones need a signed URL.
Bucket bytes count toward the workspace's storage allowance.
`

function credentials() {
  const apiUrl = (process.env.SHOGO_API_URL || '').replace(/\/+$/, '')
  const projectId = process.env.PROJECT_ID || ''
  const runtimeToken = process.env.RUNTIME_AUTH_SECRET || ''
  const apiKey = process.env.SHOGO_API_KEY || ''
  if (!apiUrl) throw new CliError('missing_credentials', 'SHOGO_API_URL is not set')
  if (!projectId) throw new CliError('missing_credentials', 'PROJECT_ID is not set')
  if (!runtimeToken && !apiKey) {
    throw new CliError('missing_credentials', 'RUNTIME_AUTH_SECRET (or SHOGO_API_KEY) is not set')
  }
  return { apiUrl, projectId, runtimeToken, apiKey }
}

class CliError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

async function api(path, init = {}) {
  const { apiUrl, projectId, runtimeToken, apiKey } = credentials()
  const headers = new Headers(init.headers)
  if (runtimeToken) headers.set('x-runtime-token', runtimeToken)
  else if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)
  const response = await fetch(`${apiUrl}/api/projects/${projectId}${path}`, { ...init, headers })
  if (!response.ok) {
    let body = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    const error = body?.error ?? {}
    const code = typeof error.code === 'string' ? error.code : `http_${response.status}`
    const message = typeof error.message === 'string' ? error.message : `request failed (${response.status})`
    throw new CliError(code, message, error)
  }
  return response
}

function visibilityFlags(values) {
  return values.private === true ? 'private' : 'public'
}

function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/')
}

function humanBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = Number(bytes) || 0
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Upload one file, streaming it. Above the multipart threshold the ticket
 * carries one URL per 16 MiB part; each part is read from disk on demand, so
 * memory stays flat whatever the file size.
 */
async function putFile(path, options) {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new CliError('not_a_file', `${path} is not a file`)
  const key = options.key
  const contentType = options.contentType || guessContentType(path)

  const created = await api('/bucket/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key,
      size: metadata.size,
      contentType,
      visibility: options.visibility,
      overwrite: options.overwrite === true,
    }),
  })
  const ticket = await created.json()

  try {
    const parts = []
    if (ticket.mode === 'multipart' && Array.isArray(ticket.parts)) {
      const partSize = ticket.partSize || MULTIPART_PART_SIZE
      for (const part of ticket.parts) {
        const start = (part.partNumber - 1) * partSize
        const end = Math.min(start + partSize, metadata.size) - 1
        const body = Readable.toWeb(createReadStream(path, { start, end }))
        const response = await fetch(part.url, {
          method: 'PUT',
          body,
          duplex: 'half',
        })
        if (!response.ok) throw new CliError('upload_failed', `part ${part.partNumber} failed (${response.status})`)
        const etag = response.headers.get('etag')
        if (!etag) throw new CliError('upload_failed', `part ${part.partNumber} returned no ETag`)
        parts.push({ ETag: etag, PartNumber: part.partNumber })
      }
    } else {
      const body = Readable.toWeb(createReadStream(path))
      const response = await fetch(ticket.url, {
        method: 'PUT',
        body,
        duplex: 'half',
        headers: ticket.headers || {},
      })
      if (!response.ok) throw new CliError('upload_failed', `upload failed (${response.status})`)
    }

    const completed = await api(`/bucket/uploads/${ticket.uploadId}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts }),
    })
    return await completed.json()
  } catch (error) {
    await api(`/bucket/uploads/${ticket.uploadId}`, { method: 'DELETE' }).catch(() => {})
    throw error
  }
}

function guessContentType(path) {
  const ext = (path.split('.').pop() || '').toLowerCase()
  const types = {
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    json: 'application/json',
    txt: 'text/plain',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
    zip: 'application/zip',
  }
  return types[ext] || 'application/octet-stream'
}

function parseSize(raw, fallback) {
  if (!raw) return fallback
  const match = /^([0-9.]+)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(String(raw).trim())
  if (!match) throw new CliError('invalid_size', `cannot read a size from "${raw}"`)
  const value = Number(match[1])
  const unit = (match[2] || 'b').toLowerCase()
  const factor = unit.startsWith('g') ? 1024 ** 3 : unit.startsWith('m') ? MB : unit.startsWith('k') ? 1024 : 1
  return Math.round(value * factor)
}

// ---------------------------------------------------------------------------
// offload
// ---------------------------------------------------------------------------

/** Every file at or above `minSize` under `dir`, as paths relative to it. */
async function collectFiles(dir, minSize) {
  const out = []
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        await walk(full)
      } else if (entry.isFile()) {
        const metadata = await stat(full).catch(() => null)
        if (metadata && metadata.size >= minSize) out.push({ path: full, size: metadata.size })
      }
    }
  }
  await walk(dir)
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** Every key already in the bucket (paged), for `offload`'s idempotency. */
async function existingKeys(visibility) {
  const keys = new Set()
  let cursor = null
  do {
    const query = new URLSearchParams({ visibility, limit: '1000' })
    if (cursor) query.set('cursor', cursor)
    const response = await api(`/bucket/objects?${query}`)
    const page = await response.json()
    for (const object of page.objects || []) keys.add(object.key)
    cursor = page.cursor
  } while (cursor)
  return keys
}

async function runOffload(positionals, values) {
  const target = positionals[0]
  if (!target) throw new CliError('missing_argument', 'offload needs a directory')
  const minSize = parseSize(values['min-size'], 5 * MB)
  const prefix = (values.prefix || 'offload').replace(/\/+$/, '')
  const visibility = visibilityFlags(values)
  const files = await collectFiles(target, minSize)
  if (files.length === 0) {
    console.log(JSON.stringify({ manifest: {}, uploaded: 0, skipped: 0 }, null, 2))
    return
  }

  const known = values['dry-run'] === true ? new Set() : await existingKeys(visibility)
  const manifest = {}
  let uploaded = 0
  let skipped = 0

  for (const file of files) {
    const relativePath = relative(target, file.path).split(sep).join('/')
    const sha = await sha256File(file.path)
    // Content-addressed: the same bytes always land on the same key, so a
    // re-run finds them and uploads nothing.
    const key = `${prefix}/${sha.slice(0, 16)}/${basename(file.path)}`
    if (known.has(key)) {
      skipped += 1
      manifest[relativePath] = await publicUrlForKey(key, visibility)
      continue
    }
    if (values['dry-run'] === true) {
      manifest[relativePath] = `(dry run) ${key}`
      continue
    }
    const stored = await putFile(file.path, {
      key,
      visibility,
      overwrite: false,
      contentType: guessContentType(file.path),
    })
    uploaded += 1
    known.add(key)
    manifest[relativePath] = stored.publicUrl || (await publicUrlForKey(key, visibility))
  }

  if (values.json === true || values['dry-run'] === true) {
    console.log(JSON.stringify({ manifest, uploaded, skipped }, null, 2))
    return
  }
  for (const [path, url] of Object.entries(manifest)) console.log(`${path}\t${url}`)
  console.error(`[shogo bucket] ${uploaded} uploaded, ${skipped} already there`)
}

async function publicUrlForKey(key, visibility) {
  if (visibility === 'private') {
    const response = await api(`/bucket/objects/${encodeKey(key)}?url=1&visibility=private`)
    const body = await response.json()
    return body.url
  }
  const response = await api(`/bucket/objects/${encodeKey(key)}?url=1&visibility=public`)
  const body = await response.json()
  return body.url
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function runBucketCommand(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      key: { type: 'string', short: 'k' },
      prefix: { type: 'string' },
      private: { type: 'boolean' },
      public: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      'content-type': { type: 'string' },
      'min-size': { type: 'string' },
      signed: { type: 'boolean' },
      expires: { type: 'string' },
      json: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  const command = positionals[0]
  const rest = positionals.slice(1)
  const visibility = visibilityFlags(values)

  if (!command || command === 'help' || values.help === true) {
    console.log(USAGE)
    return 0
  }

  switch (command) {
    case 'put': {
      if (rest.length === 0) throw new CliError('missing_argument', 'put needs at least one file path')
      const prefix = values.prefix ? `${values.prefix.replace(/\/+$/, '')}/` : ''
      const results = []
      for (const path of rest) {
        const key = values.key || `${prefix}${basename(path)}`
        const stored = await putFile(path, {
          key,
          visibility,
          overwrite: values.overwrite === true,
          contentType: values['content-type'],
        })
        results.push({ path, key: stored.key, size: stored.size, url: stored.publicUrl })
        console.log(`${path} -> ${stored.publicUrl || stored.key} (${humanBytes(stored.size)})`)
      }
      if (values.json === true) console.log(JSON.stringify({ objects: results }, null, 2))
      return 0
    }

    case 'ls': {
      const prefix = rest[0] || ''
      let cursor = null
      const rows = []
      do {
        const query = new URLSearchParams({ visibility, limit: '1000' })
        if (prefix) query.set('prefix', prefix)
        if (cursor) query.set('cursor', cursor)
        const response = await api(`/bucket/objects?${query}`)
        const page = await response.json()
        rows.push(...(page.objects || []))
        cursor = page.cursor
      } while (cursor)
      if (values.json === true) {
        console.log(JSON.stringify({ objects: rows }, null, 2))
      } else {
        for (const row of rows) console.log(`${humanBytes(row.size).padStart(10)}  ${row.key}`)
        if (rows.length === 0) console.error('[shogo bucket] no objects')
      }
      return 0
    }

    case 'rm': {
      if (rest.length === 0) throw new CliError('missing_argument', 'rm needs at least one key')
      for (const key of rest) {
        await api(`/bucket/objects/${encodeKey(key)}?visibility=${visibility}`, { method: 'DELETE' })
        console.log(`deleted ${key}`)
      }
      return 0
    }

    case 'url': {
      const key = rest[0]
      if (!key) throw new CliError('missing_argument', 'url needs a key')
      const expires = Math.min(Math.max(Number(values.expires || 3600), 60), 86400)
      const query = new URLSearchParams({ url: '1', visibility, expiresIn: String(expires) })
      const response = await api(`/bucket/objects/${encodeKey(key)}?${query}`)
      const body = await response.json()
      // Public answers the CDN URL; private answers a presigned (cloud) or
      // token-signed (desktop) URL that expires.
      console.log(body.url)
      return 0
    }

    case 'usage': {
      const response = await api('/bucket/usage')
      const usage = await response.json()
      if (values.json === true) {
        console.log(JSON.stringify(usage, null, 2))
        return 0
      }
      const allowance = usage.allowanceBytes > 1e15 ? 'unlimited' : humanBytes(usage.allowanceBytes)
      console.log(`project bucket  ${humanBytes(usage.projectBytes)} in ${usage.projectObjects} object(s)`)
      console.log(`workspace       ${humanBytes(usage.workspaceUsedBytes)} of ${allowance} used`)
      console.log(`billing         ${usage.billingMode} @ $${usage.usdPerGbMonth}/GB-month over the allowance`)
      console.log(`public base     ${usage.publicBaseUrl}`)
      return 0
    }

    case 'offload':
      await runOffload(rest, values)
      return 0

    default:
      console.error(`Unknown bucket command: ${command}`)
      console.error(USAGE)
      return 1
  }
}

/** Entry point used by bin/cli.mjs. Always exits. */
export async function bucketMain(argv) {
  try {
    const code = await runBucketCommand(argv)
    process.exit(code)
  } catch (error) {
    if (error instanceof CliError) {
      // Print the API's own code and message verbatim: the agent relays them
      // (a 402 carries the Billing link; a 409 tells it to pass --overwrite).
      console.error(`[shogo bucket] ${error.code}: ${error.message}`)
      const details = error.details || {}
      for (const field of ['reason', 'usedBytes', 'allowanceBytes', 'usdPerGbMonth', 'billingUrl']) {
        if (details[field] !== undefined) console.error(`[shogo bucket]   ${field}: ${details[field]}`)
      }
      process.exit(1)
    }
    console.error(`[shogo bucket] ${error?.message ?? error}`)
    process.exit(1)
  }
}
