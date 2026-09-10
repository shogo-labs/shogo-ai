import { promises as fsp } from 'fs'
import { join } from 'path'

export type CloneMode = 'link' | 'copy'

export interface CloneTreeResult {
  files: number
  dirs: number
  symlinks: number
  /** Mode in effect when the clone finished (a `link` clone may downgrade to `copy`). */
  mode: CloneMode
}

export interface CloneTreeOptions {
  /** `link` (default) hard-links files and falls back to copying when the filesystem refuses. */
  mode?: CloneMode
  /** Concurrent file operations in flight. */
  concurrency?: number
}

const LINK_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'EACCES', 'EINVAL'])

/**
 * Replicate `src` at `dst` (which must not exist yet).
 *
 * Regular files are hard-linked by default: a 40k-file `node_modules` clones in
 * a couple of seconds and costs no extra disk, versus a minute for a fresh
 * `npm install` on Windows. Package managers replace files by unlink+write, so
 * a later install inside one clone never mutates the shared inodes. If the
 * first link attempt fails (other volume, FAT/exFAT, restricted ACLs) the rest
 * of the tree is copied instead.
 *
 * Symlinks are recreated as symlinks (macOS `node_modules/.bin`); directories
 * are walked, never linked.
 *
 * The walk is fully async and bounded so a clone on the open path does not
 * stall the API event loop.
 */
export async function cloneTree(src: string, dst: string, opts: CloneTreeOptions = {}): Promise<CloneTreeResult> {
  const result: CloneTreeResult = { files: 0, dirs: 0, symlinks: 0, mode: opts.mode ?? 'link' }
  const concurrency = Math.max(1, opts.concurrency ?? 32)

  let active = 0
  const waiters: Array<() => void> = []
  const acquire = () =>
    new Promise<void>((resolve) => {
      if (active < concurrency) {
        active++
        resolve()
      } else {
        waiters.push(() => {
          active++
          resolve()
        })
      }
    })
  const release = () => {
    active--
    const next = waiters.shift()
    if (next) next()
  }

  const pending: Promise<void>[] = []
  let firstError: unknown = null

  const placeFile = async (from: string, to: string) => {
    if (result.mode === 'link') {
      try {
        await fsp.link(from, to)
        return
      } catch (err: any) {
        if (!LINK_FALLBACK_CODES.has(err?.code)) throw err
        result.mode = 'copy'
      }
    }
    await fsp.copyFile(from, to)
  }

  const walk = async (from: string, to: string): Promise<void> => {
    await fsp.mkdir(to)
    result.dirs++
    const entries = await fsp.readdir(from, { withFileTypes: true })
    for (const entry of entries) {
      if (firstError) return
      const childFrom = join(from, entry.name)
      const childTo = join(to, entry.name)
      if (entry.isDirectory()) {
        await walk(childFrom, childTo)
      } else if (entry.isSymbolicLink()) {
        await acquire()
        pending.push(
          fsp
            .readlink(childFrom)
            .then((target) => fsp.symlink(target, childTo))
            .then(() => {
              result.symlinks++
            })
            .catch((err) => {
              firstError ??= err
            })
            .finally(release),
        )
      } else if (entry.isFile()) {
        await acquire()
        pending.push(
          placeFile(childFrom, childTo)
            .then(() => {
              result.files++
            })
            .catch((err) => {
              firstError ??= err
            })
            .finally(release),
        )
      }
      // Sockets, FIFOs, devices: nothing a workspace needs.
    }
  }

  await walk(src, dst)
  await Promise.all(pending)
  if (firstError) throw firstError
  return result
}
