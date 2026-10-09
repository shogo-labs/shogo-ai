// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * `/pool/export-home` and `/pool/hydrate-home`: the host side of
 * {@link ./home-state}. Plain `Request -> Response` handlers so the metal
 * host's test harness drives exactly the code the guest serves.
 *
 * Both answer 404 unless the guest is host-mediated (metal) AND was assigned a
 * key. That one status covers "older runtime", "desktop", and "no master key
 * configured" alike, and the host treats it as permanent for the VM, so there
 * is no state in which a guest without a key keeps being asked.
 *
 * Export status codes mirror `/pool/export-data`:
 *   200 ciphertext + ETag · 204 nothing persisted · 304 unchanged · 413 too large
 */

import { join } from 'node:path'
import {
  HOME_STATE_MAX_BLOB_BYTES,
  HomeStateDecryptError,
  HomeStateInvalidArchiveError,
  HomeStateTooLargeError,
  decryptHomeState,
  encryptHomeState,
  homeStateTag,
  packHomeState,
  parseHomeStateKey,
  resolveHomeDir,
  restoreHomeState,
  scanHomeState,
  sweepHomeRestoreStages,
  type HomeStateKey,
} from './home-state'

export interface HomeStateConfig {
  homeDir: string
  key: HomeStateKey
  projectId: string
}

/** Null when this guest must not persist its home directory. */
export function homeStateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HomeStateConfig | null {
  const mediated = env.SHOGO_DURABILITY_HOST_MEDIATED
  if (mediated !== '1' && mediated !== 'true') return null
  const projectId = env.PROJECT_ID
  if (!projectId || projectId === '__POOL__') return null
  const key = parseHomeStateKey(env)
  if (!key) return null
  return { homeDir: resolveHomeDir(env), key, projectId }
}

function disabled(): Response {
  return Response.json({ error: 'home-state persistence is not enabled on this runtime' }, { status: 404 })
}

export async function handleExportHome(
  req: Request,
  opts: { env?: NodeJS.ProcessEnv; stageDir: () => string },
): Promise<Response> {
  const cfg = homeStateConfigFromEnv(opts.env)
  if (!cfg) return disabled()

  const fsp = await import('node:fs/promises')
  let stage: string | null = null
  try {
    const scan = scanHomeState(cfg.homeDir)
    const tag = homeStateTag(scan)
    if (tag === null) return new Response(null, { status: 204 })
    if (req.headers.get('if-none-match') === tag) {
      return new Response(null, { status: 304, headers: { ETag: tag } })
    }

    stage = await fsp.mkdtemp(join(opts.stageDir(), 'shogo-home-export-'))
    const pack = await packHomeState(cfg.homeDir, { stageDir: stage, scan })
    if (!pack) return new Response(null, { status: 204 })
    const blob = encryptHomeState(pack.gz, { key: cfg.key, projectId: cfg.projectId })
    console.log(
      `[pool/export-home] packed ${pack.entries} entries (${pack.bytes} bytes raw, ${blob.byteLength} encrypted)` +
        (pack.skipped.length ? `, skipped ${pack.skipped.length}` : ''),
    )
    return new Response(new Uint8Array(blob), {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        ETag: tag,
        'X-Shogo-Home-Entries': String(pack.entries),
        'X-Shogo-Home-Key-Version': String(cfg.key.version),
      },
    })
  } catch (err: any) {
    if (err instanceof HomeStateTooLargeError) {
      console.error(`[pool/export-home] refused: ${err.message}`)
      return Response.json({ error: err.message }, { status: 413 })
    }
    console.error('[pool/export-home] failed:', err?.message ?? err)
    return Response.json({ error: err?.message ?? 'export failed' }, { status: 500 })
  } finally {
    if (stage) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

export async function handleHydrateHome(req: Request, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<Response> {
  const cfg = homeStateConfigFromEnv(opts.env)
  if (!cfg) return disabled()

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (declared > HOME_STATE_MAX_BLOB_BYTES) return Response.json({ error: 'home archive too large' }, { status: 413 })
  const blob = new Uint8Array(await req.arrayBuffer())
  if (blob.byteLength === 0) return Response.json({ error: 'empty archive' }, { status: 400 })
  if (blob.byteLength > HOME_STATE_MAX_BLOB_BYTES) {
    return Response.json({ error: 'home archive too large' }, { status: 413 })
  }

  try {
    sweepHomeRestoreStages(cfg.homeDir)
    const gz = decryptHomeState(blob, { key: cfg.key, projectId: cfg.projectId })
    const { units } = await restoreHomeState(cfg.homeDir, gz)
    const tops = [...new Set(units.map((u) => u.split('/')[0]))]
    console.log(`[pool/hydrate-home] restored ${units.length} unit(s) under ${tops.join(', ')}`)
    return Response.json({ ok: true, units })
  } catch (err: any) {
    if (err instanceof HomeStateDecryptError || err instanceof HomeStateInvalidArchiveError) {
      console.error(`[pool/hydrate-home] rejected archive: ${err.message}`)
      return Response.json({ error: err.message }, { status: 422 })
    }
    console.error('[pool/hydrate-home] failed:', err?.message ?? err)
    return Response.json({ error: err?.message ?? 'hydrate failed' }, { status: 500 })
  }
}
