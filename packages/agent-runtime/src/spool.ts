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

import { mkdirSync, readdirSync, readlinkSync, rmSync, statSync, statfsSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'

/** `man 2 statfs` f_type values for the in-memory filesystems. */
const TMPFS_MAGIC = 0x01021994
const RAMFS_MAGIC = 0x858458f6

/** Files older than this are assumed orphaned by a crashed request. */
const SWEEP_AGE_MS = 60 * 60 * 1000

/**
 * How long a streamed spool may go without its consumer pulling a chunk before
 * we assume the download is dead and close the descriptor.
 *
 * A guest's export is pulled in 1 MiB chunks continuously; two minutes of
 * silence is not a slow link, it is a caller that went away without closing
 * anything. Waiting forever for `cancel()` is what pinned 3.6 GB of deleted
 * inodes on Samsara's rootfs (SHO-352).
 */
export const SPOOL_IDLE_TIMEOUT_MS = 120_000

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

/** Whether `candidate` is `parent` or lives underneath it. */
function isInside(candidate: string, parent: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Pick a scratch directory for `workspaceDir`, preferring the platform temp dir
 * and falling back to a sibling of the workspace when temp is RAM.
 *
 * The fallback is a SIBLING, never a child: anything inside the workspace gets
 * swept up by `packProjectArchive` and shipped to durable storage as if the
 * user had written it.
 *
 * `SHOGO_SPOOL_DIR` (exported by fc-init on metal, where it points at
 * `/data/.shogo-spool` — the project's own drive, beside the bind-mounted
 * workspace) wins over both when it is set and usable. Without it, a guest's
 * 2 GB export lands on `/app`, the 16 GiB rootfs shared with `node_modules`,
 * which is the filesystem with the least room (SHO-352). A value pointing into
 * the workspace is refused, for the same reason as the adjacent fallback.
 */
export function resolveSpoolDir(
  workspaceDir: string,
  probe: SpoolProbe = defaultProbe,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.SHOGO_SPOOL_DIR?.trim()
  if (configured) {
    if (isInside(configured, workspaceDir)) {
      console.warn(
        `[spool] SHOGO_SPOOL_DIR=${configured} is inside the workspace (${workspaceDir}); ` +
          `it would be packed into the project archive — ignoring it.`,
      )
    } else if (!probe.isRamBacked(configured) && probe.ensureWritable(configured)) {
      return configured
    } else {
      console.warn(`[spool] SHOGO_SPOOL_DIR=${configured} is unusable (RAM-backed or not writable); ignoring it.`)
    }
  }

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
  // A descriptor that outlived its unlink is invisible to the sweep above: the
  // name is gone from the listing while the inode is still allocated, which is
  // exactly the state Samsara sat in for two days. Report it instead of leaving
  // the only symptom as "no space left on device" (SHO-352).
  logLeakedSpoolDescriptors(dir)
  return removed
}

/**
 * Warn about spool files this process has unlinked but still holds open.
 *
 * Deleting the name is not reclaiming the space: POSIX keeps the inode alive
 * while any descriptor refers to it. `readdir` therefore shows nothing while
 * gigabytes stay allocated — the gap that made a 16 GiB guest rootfs report
 * 100% full with `du -x /` accounting for only 11 GiB (SHO-352).
 */
export function logLeakedSpoolDescriptors(dir: string = spoolDir()): number {
  // /proc/self/fd is the only portable-ish way to see this, and it is Linux
  // only — which is where the guest runs. Elsewhere: nothing to check.
  if (process.platform !== 'linux') return 0
  let leaked = 0
  let bytes = 0
  const targets: string[] = []
  try {
    for (const entry of readdirSync('/proc/self/fd')) {
      let target: string
      try {
        target = readlinkSync(join('/proc/self/fd', entry))
      } catch {
        continue
      }
      if (!target.endsWith(' (deleted)')) continue
      const file = target.slice(0, -' (deleted)'.length)
      if (!isInside(file, dir)) continue
      leaked++
      targets.push(file.slice(dir.length + 1))
      try {
        bytes += statSync(join('/proc/self/fd', entry)).size
      } catch {}
    }
  } catch {
    return 0
  }
  if (leaked > 0) {
    console.warn(
      `[spool] leaked ${leaked} deleted spool descriptor(s) holding ${bytes} byte(s) in ${dir}: ` +
        `${targets.slice(0, 5).join(', ')}${targets.length > 5 ? ', …' : ''}`,
    )
  }
  return leaked
}

const STREAM_CHUNK = 1024 * 1024

export interface SpooledFileOptions {
  /**
   * The request's abort signal (`c.req.raw.signal`).
   *
   * The descriptor cannot be left to the stream's `cancel()`: Bun.serve does
   * not call it when the client drops the connection mid-body, which is why
   * five deleted `/pool/export` tarballs stayed open in pid 1 and pinned 3.6 GB
   * on Samsara's rootfs (SHO-352). An abort is the signal we actually receive,
   * so it has to be the one that releases the file.
   */
  signal?: AbortSignal
  /** Close after this long with no `pull()`. `0` disables the watchdog. */
  idleTimeoutMs?: number
}

/**
 * Serve a spooled archive as a streaming response and delete it, without ever
 * holding it whole.
 *
 * `readFileSync(path)` costs the archive's full size in RAM at the moment of
 * responding, which for a 1.8 GB export is most of the guest. Streaming from
 * an open descriptor costs one chunk.
 *
 * The unlink happens up front, before a single byte is sent, so the name is
 * gone even if we are killed mid-download. That only reclaims the disk when the
 * descriptor also closes, and POSIX keeps the inode alive for as long as any
 * descriptor refers to it — so every path out of here (EOF, `cancel()`, an
 * aborted request, a consumer that stops pulling) must close it. Getting that
 * wrong does not leak a handle, it leaks gigabytes.
 */
export async function spooledFileResponse(
  path: string,
  headers: Record<string, string>,
  opts: SpooledFileOptions = {},
): Promise<Response> {
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
  if (opts.signal?.aborted) {
    await fh.close().catch(() => {})
    throw new Error('caller aborted before the spooled download started')
  }
  // Best-effort by contrast — if the name cannot be removed the bytes are
  // still correct, and `sweepSpool` reclaims it later.
  await fsp.unlink(path).catch(() => {})

  const idleMs = opts.idleTimeoutMs ?? SPOOL_IDLE_TIMEOUT_MS
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let closed = false
  /** Why we closed, so a pull that starts afterwards reports it instead of EOF. */
  let closedWith: Error | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  /** Idempotent, and the only place the descriptor is closed. */
  const release = async (err?: Error): Promise<void> => {
    if (closed) return
    closed = true
    closedWith = err ?? null
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    opts.signal?.removeEventListener('abort', onAbort)
    await fh.close().catch(() => {})
    if (err) {
      try {
        controller?.error(err)
      } catch {}
    }
  }

  const onAbort = (): void => {
    void release(new Error('caller aborted the spooled download'))
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  // A consumer that takes one chunk and then goes quiet — a hung socket the
  // runtime never reports as aborted — is the same leak by another route.
  const armIdle = (): void => {
    if (!(idleMs > 0)) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      void release(new Error(`spooled download stalled for ${idleMs}ms`))
    }, idleMs)
    // Never keep the process alive for a watchdog.
    ;(idleTimer as unknown as { unref?: () => void }).unref?.()
  }
  armIdle()

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
      // An abort that landed between the check above and this assignment.
      if (opts.signal?.aborted) onAbort()
    },
    async pull(c) {
      if (closed) {
        // A chunk the consumer asked for after we gave up must surface the
        // reason: a silent EOF would look like a complete archive.
        if (closedWith) c.error(closedWith)
        else c.close()
        return
      }
      armIdle()
      const buf = Buffer.allocUnsafe(STREAM_CHUNK)
      let bytesRead: number
      try {
        ;({ bytesRead } = await fh.read(buf, 0, STREAM_CHUNK, null))
      } catch (err: any) {
        // A read already in flight when the watchdog or an abort closed the
        // descriptor fails with EBADF; that is the expected outcome, not news.
        if (!closed) {
          await release(err instanceof Error ? err : new Error(String(err)))
        } else if (closedWith) {
          try {
            c.error(closedWith)
          } catch {}
        } else {
          try {
            c.close()
          } catch {}
        }
        return
      }
      if (bytesRead === 0) {
        await release()
        c.close()
        return
      }
      c.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead))
    },
    async cancel() {
      await release()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { ...headers, 'Content-Length': String(size) },
  })
}
