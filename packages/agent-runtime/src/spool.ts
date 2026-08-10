// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * A scratch directory for multi-gigabyte archives that is guaranteed not to be
 * RAM.
 *
 * The guest mounts `/tmp` as tmpfs with no `size=` (scripts/metal-agent/
 * build-runtime-rootfs.sh), which Linux defaults to half of RAM — about 2 GiB
 * in a 4 GiB microVM. So `os.tmpdir()` in the guest is memory wearing a
 * filesystem's clothes, and "spool it to a file instead of buffering it" buys
 * nothing there: a 1.9 GB hydrate spooled to `/tmp` killed the VM outright
 * (`fc process gone`) while the same code passed every test on a laptop, where
 * `/tmp` is a real disk. Nothing in the type system or a unit test distinguishes
 * those two directories, so this module asks the filesystem.
 *
 * The rule is "prefer tmpdir, but never if it is RAM", which keeps normal
 * environments on the path they already use and only diverges where it matters.
 */

import { mkdirSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** `man 2 statfs` f_type values for the in-memory filesystems. */
const TMPFS_MAGIC = 0x01021994
const RAMFS_MAGIC = 0x858458f6

/** Files older than this are assumed orphaned by a crashed request. */
const SWEEP_AGE_MS = 60 * 60 * 1000

export interface SpoolProbe {
  tmpdir: () => string
  isRamBacked: (path: string) => boolean
  ensureWritable: (path: string) => boolean
}

/**
 * Whether `path` lives on a memory-backed filesystem.
 *
 * Fails to `false`: on a platform where statfs reports something we don't
 * recognise (macOS returns its own values), the honest answer is "no evidence
 * this is RAM", and the caller's existing behaviour is the safer default.
 */
export function isRamBacked(path: string): boolean {
  try {
    const type = Number((statfsSync(path) as unknown as { type: number | bigint }).type)
    return type === TMPFS_MAGIC || type === RAMFS_MAGIC
  } catch {
    return false
  }
}

function ensureWritable(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true })
    // mkdir succeeding does not prove we can write into it (read-only mount,
    // full filesystem, wrong owner), and we only find out at 2 GB otherwise.
    const probe = join(path, `.write-probe-${process.pid}`)
    writeFileSync(probe, 'x')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

const defaultProbe: SpoolProbe = { tmpdir, isRamBacked, ensureWritable }

/**
 * Pick a scratch directory for `workspaceDir`, preferring the platform temp dir
 * and falling back to a sibling of the workspace when temp is RAM.
 *
 * The fallback is a SIBLING, never a child: anything inside the workspace gets
 * swept up by `packProjectArchive` and shipped to durable storage as if the
 * user had written it.
 */
export function resolveSpoolDir(workspaceDir: string, probe: SpoolProbe = defaultProbe): string {
  const tmp = join(probe.tmpdir(), 'shogo-spool')
  if (!probe.isRamBacked(probe.tmpdir()) && probe.ensureWritable(tmp)) return tmp

  const adjacent = join(dirname(workspaceDir), '.shogo-spool')
  if (!probe.isRamBacked(dirname(workspaceDir)) && probe.ensureWritable(adjacent)) return adjacent

  // Everything we can reach is RAM. Use temp anyway — the caller has to put the
  // bytes somewhere, and a loud log beats a silent OOM two gigabytes later.
  console.warn(
    `[spool] no disk-backed scratch directory found (tried ${tmp}, ${adjacent}); ` +
      `falling back to RAM-backed ${tmp}. Large archives may exhaust memory.`,
  )
  probe.ensureWritable(tmp)
  return tmp
}

let cached: string | null = null

/** Memoized spool directory for the running agent. */
export function spoolDir(workspaceDir?: string): string {
  if (cached) return cached
  const ws = workspaceDir ?? process.env.WORKSPACE_DIR ?? process.env.AGENT_DIR ?? process.env.PROJECT_DIR ?? '/app/workspace'
  cached = resolveSpoolDir(ws)
  return cached
}

/** Test seam: forget the memoized directory. */
export function resetSpoolDir(): void {
  cached = null
}

/** A unique path inside the spool directory. `name` should include an extension. */
export function spoolPath(name: string, workspaceDir?: string): string {
  return join(spoolDir(workspaceDir), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`)
}

/**
 * Delete spool entries older than `maxAgeMs`.
 *
 * A request killed between writing the spool and its `finally` leaves a
 * multi-gigabyte file behind, and the guest's disk is not large enough to
 * absorb many of those. Cheap enough to call on the way into each spooling
 * request.
 */
export function sweepSpool(maxAgeMs: number = SWEEP_AGE_MS, workspaceDir?: string): number {
  const dir = spoolDir(workspaceDir)
  let removed = 0
  try {
    const cutoff = Date.now() - maxAgeMs
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      try {
        if (statSync(full).mtimeMs >= cutoff) continue
        rmSync(full, { recursive: true, force: true })
        removed++
      } catch {}
    }
  } catch {}
  if (removed) console.log(`[spool] swept ${removed} stale file(s) from ${dir}`)
  return removed
}

const STREAM_CHUNK = 1024 * 1024

/**
 * Serve a spooled archive as a streaming response and delete it, without ever
 * holding it whole.
 *
 * `readFileSync(path)` costs the archive's full size in RAM at the moment of
 * responding, which for a 1.8 GB export is most of the guest. Streaming from
 * an open descriptor costs one chunk.
 *
 * The unlink happens up front, before a single byte is sent. POSIX keeps the
 * inode alive as long as we hold the descriptor, so the bytes remain readable
 * while the name is already gone — which means the disk is reclaimed even if
 * the caller hangs up mid-download or the process is killed, the two cases a
 * `finally` block does not cover.
 */
export async function spooledFileResponse(path: string, headers: Record<string, string>): Promise<Response> {
  const fsp = await import('node:fs/promises')
  const fh = await fsp.open(path, 'r')
  let size: number
  try {
    // Not best-effort: a wrong Content-Length against a correct stream is a
    // truncated or hung download, so fail here where the caller still has a
    // 500 to return.
    size = (await fh.stat()).size
  } catch (err) {
    await fh.close().catch(() => {})
    throw err
  }
  // Best-effort by contrast — if the name cannot be removed the bytes are
  // still correct, and `sweepSpool` reclaims it later.
  await fsp.unlink(path).catch(() => {})

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buf = Buffer.allocUnsafe(STREAM_CHUNK)
      const { bytesRead } = await fh.read(buf, 0, STREAM_CHUNK, null)
      if (bytesRead === 0) {
        await fh.close().catch(() => {})
        controller.close()
        return
      }
      controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead))
    },
    async cancel() {
      await fh.close().catch(() => {})
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) },
  })
}
