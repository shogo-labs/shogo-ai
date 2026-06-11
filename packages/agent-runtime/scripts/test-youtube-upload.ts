// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repro + verification harness for the Composio file-upload regression that
 * broke YOUTUBE_UPLOAD_VIDEO / YOUTUBE_MULTIPART_UPLOAD_VIDEO after the
 * @composio/core 0.6.5 -> 0.10.0 upgrade.
 *
 * SDK 0.10 turns automatic file upload OFF by default
 * (`dangerouslyAllowAutoUploadDownloadFiles` defaults to false). A raw local
 * path passed to a `file_uploadable` field is then forwarded as-is and the
 * backend mis-reads it as an existing `s3key`, failing with:
 *   "Failed to download file with s3key '…': storage returned HTTP 404"
 *
 * This script proves the regression and that the flag fixes it, end-to-end,
 * against a *throwaway* YouTube channel. Uploads are private/unlisted.
 *
 * Usage (run from packages/agent-runtime):
 *   # 1. Start the OAuth flow for a throwaway test user, then open the URL,
 *   #    sign in with a throwaway Google account, and grant YouTube scope.
 *   COMPOSIO_API_KEY=… bun scripts/test-youtube-upload.ts connect
 *
 *   # 2. Poll until the connection is active.
 *   COMPOSIO_API_KEY=… bun scripts/test-youtube-upload.ts wait
 *
 *   # 3a. Reproduce the bug (flag OFF): expect the s3key HTTP 404.
 *   COMPOSIO_API_KEY=… bun scripts/test-youtube-upload.ts upload --mode=off
 *
 *   # 3b. Verify the fix (flag ON): expect an unlisted video id, no s3key error.
 *   COMPOSIO_API_KEY=… bun scripts/test-youtube-upload.ts upload --mode=on
 *
 *   # 3c. Same as 3b but pass a RELATIVE path (cwd = the media dir) to see
 *   #     whether relative file args also need fixing.
 *   COMPOSIO_API_KEY=… bun scripts/test-youtube-upload.ts upload --mode=on --relative
 *
 * Optional flags:
 *   --slug=YOUTUBE_UPLOAD_VIDEO | YOUTUBE_MULTIPART_UPLOAD_VIDEO  (default: both)
 *   --user=<composioUserId>   (default: shogo_test_youtube_upload)
 *   --file=<path to mp4>      (default: <mediaDir>/test.mp4)
 *   --dir=<media dir>         (default: /tmp/shogo-test)
 */

import { Composio } from '@composio/core'

const TOOLKIT = 'youtube'
const DEFAULT_USER = 'shogo_test_youtube_upload'
const DEFAULT_DIR = '/tmp/shogo-test'
const FILE_FIELD: Record<string, string> = {
  YOUTUBE_UPLOAD_VIDEO: 'videoFilePath',
  YOUTUBE_MULTIPART_UPLOAD_VIDEO: 'videoFile',
}

function loadDotEnv() {
  const fs = require('node:fs') as typeof import('node:fs')
  const candidates = ['.env.local', '.env', '../../.env.local', '../../.env']
  for (const path of candidates) {
    if (!fs.existsSync(path)) continue
    const text = fs.readFileSync(path, 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)
      if (!m) continue
      const key = m[1]
      let value = m[2]
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
}

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  return fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function requireApiKey(): string {
  const apiKey = process.env.COMPOSIO_API_KEY
  if (!apiKey) {
    console.error('COMPOSIO_API_KEY not set. Aborting.')
    process.exit(1)
  }
  return apiKey
}

function userId(): string {
  return arg('user', DEFAULT_USER)!
}

function mediaDir(): string {
  return arg('dir', DEFAULT_DIR)!
}

function fileUploadDirs(): string[] {
  const home = process.env.HOME
  const dirs = [mediaDir()]
  if (home) dirs.push(`${home}/.composio/temp`)
  return dirs
}

function targetSlugs(): string[] {
  const one = arg('slug')
  if (one) return [one]
  return ['YOUTUBE_UPLOAD_VIDEO', 'YOUTUBE_MULTIPART_UPLOAD_VIDEO']
}

function ensureTestFile(): string {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const { execSync } = require('node:child_process') as typeof import('node:child_process')
  const dir = mediaDir()
  const file = arg('file', path.join(dir, 'test.mp4'))!
  if (fs.existsSync(file)) return file
  fs.mkdirSync(dir, { recursive: true })
  try {
    execSync(
      `ffmpeg -y -f lavfi -i testsrc=duration=3:size=320x240:rate=10 -pix_fmt yuv420p "${file}"`,
      { stdio: 'ignore' },
    )
  } catch {
    console.error(
      `Could not create a test clip with ffmpeg, and no file at ${file}.\n` +
        `Install ffmpeg or pass --file=<path to a small .mp4>.`,
    )
    process.exit(1)
  }
  return file
}

async function cmdConnect() {
  const apiKey = requireApiKey()
  const uid = userId()
  const composio = new Composio({ apiKey })
  await composio.create(uid)
  const session = await composio.create(uid)
  const connection = await session.authorize(TOOLKIT, {})
  const redirectUrl =
    (connection as any)?.redirectUrl || (connection as any)?.redirect_url
  console.log(`\nComposio test user: ${uid}`)
  if (redirectUrl) {
    console.log(`\nOpen this URL, sign in with a THROWAWAY Google/YouTube account, and grant access:\n`)
    console.log(`  ${redirectUrl}\n`)
    console.log(`Then run:  bun scripts/test-youtube-upload.ts wait`)
  } else {
    console.log('Already connected (no redirect URL returned).')
  }
}

async function cmdWait() {
  const apiKey = requireApiKey()
  const uid = userId()
  const composio = new Composio({ apiKey })
  const deadline = Date.now() + 5 * 60 * 1000
  process.stdout.write(`Waiting for "${TOOLKIT}" to become active for ${uid} `)
  while (Date.now() < deadline) {
    const list = await composio.connectedAccounts.list({
      userIds: [uid],
      toolkitSlugs: [TOOLKIT],
    })
    const items: any[] = (list as any).items ?? (list as any).data ?? []
    const active = items.find(a => a.status?.toLowerCase() === 'active')
    if (active) {
      console.log(`\nActive. account id=${active.id}`)
      return
    }
    process.stdout.write('.')
    await new Promise(r => setTimeout(r, 3000))
  }
  console.log('\nTimed out waiting for an active connection.')
  process.exit(1)
}

async function cmdUpload() {
  const apiKey = requireApiKey()
  const uid = userId()
  const mode = arg('mode', 'on') // 'on' | 'off'
  const relative = hasFlag('relative')
  const path = require('node:path') as typeof import('node:path')
  const absFile = ensureTestFile()
  const passPath = relative ? path.basename(absFile) : absFile
  const cwdForRelative = relative ? path.dirname(absFile) : process.cwd()

  if (relative) process.chdir(cwdForRelative)

  const composio =
    mode === 'off'
      ? new Composio({ apiKey, toolkitVersions: 'latest' })
      : new Composio({
          apiKey,
          toolkitVersions: 'latest',
          dangerouslyAllowAutoUploadDownloadFiles: true,
          fileUploadDirs: fileUploadDirs(),
        })

  console.log(
    `\nmode=${mode} relative=${relative} file=${passPath} cwd=${process.cwd()}\n` +
      `fileUploadDirs=${mode === 'on' ? JSON.stringify(fileUploadDirs()) : '(default)'}\n`,
  )

  for (const slug of targetSlugs()) {
    const field = FILE_FIELD[slug]
    if (!field) {
      console.log(`[${slug}] unknown file field, skipping`)
      continue
    }
    const args: Record<string, unknown> = {
      title: `shogo upload test ${new Date().toISOString()}`,
      description: 'Automated test upload (composio file-upload regression).',
      categoryId: '22',
      privacyStatus: 'unlisted',
      [field]: passPath,
    }
    if (slug === 'YOUTUBE_UPLOAD_VIDEO') args.tags = ['shogo-test']

    console.log(`\n=== ${slug} (${field}) ===`)
    try {
      const result = await composio.tools.execute(slug, {
        userId: uid,
        arguments: args,
        dangerouslySkipVersionCheck: true,
      })
      const ok = (result as any).successful
      const summary = JSON.stringify((result as any).data ?? result).slice(0, 600)
      const errText = JSON.stringify((result as any).error ?? '').slice(0, 600)
      console.log(`  successful=${ok}`)
      if (ok) console.log(`  data: ${summary}`)
      else console.log(`  error: ${errText || summary}`)
    } catch (err: any) {
      const cause = err?.cause
      console.log(`  THREW: ${err?.message}`)
      if (cause) console.log(`  cause: ${JSON.stringify(cause?.error ?? cause?.message ?? cause).slice(0, 600)}`)
    }
  }
}

async function cmdDetails() {
  const apiKey = requireApiKey()
  const uid = userId()
  const ids = (arg('ids') || '').split(',').map(s => s.trim()).filter(Boolean)
  if (ids.length === 0) {
    console.error('Pass --ids=ID1,ID2,…')
    process.exit(1)
  }
  const composio = new Composio({ apiKey, toolkitVersions: 'latest' })
  const result = await composio.tools.execute('YOUTUBE_GET_VIDEO_DETAILS_BATCH', {
    userId: uid,
    arguments: { id: ids.join(','), part: 'status,processingDetails,snippet' },
    dangerouslySkipVersionCheck: true,
  })
  const data: any = (result as any).data ?? result
  const items: any[] = data?.response_data?.items ?? data?.items ?? []
  if (items.length === 0) {
    console.log(JSON.stringify(data).slice(0, 1500))
    return
  }
  for (const v of items) {
    console.log(
      `${v.id}  uploadStatus=${v.status?.uploadStatus}  ` +
        `failureReason=${v.status?.failureReason ?? '-'}  ` +
        `processing=${v.processingDetails?.processingStatus ?? '-'}  ` +
        `title="${v.snippet?.title ?? ''}"`,
    )
  }
}

async function main() {
  loadDotEnv()
  const cmd = process.argv[2]
  switch (cmd) {
    case 'connect':
      return cmdConnect()
    case 'wait':
      return cmdWait()
    case 'upload':
      return cmdUpload()
    case 'details':
      return cmdDetails()
    default:
      console.log(
        'Usage: bun scripts/test-youtube-upload.ts <connect|wait|upload> [--mode=on|off] [--relative] [--slug=…] [--user=…] [--file=…] [--dir=…]',
      )
      process.exit(1)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
