import { promises as fsp, constants as fsConstants } from 'fs'
import { join } from 'path'

export type CloneMode = 'link' | 'ficlone' | 'copy'

export interface CloneTreeResult {
  files: number
  dirs: number
  symlinks: number
  /** Mode in effect when the clone finished (a `link`/`ficlone` clone may downgrade to `copy`). */
  mode: CloneMode
}

export interface CloneTreeOptions {
  /**
   * `link` hard-links files (Windows/Linux default); `ficlone` requests an
   * APFS copy-on-write clone (macOS default, see {@link defaultCloneMode});
   * either falls back to copying when the filesystem refuses. `copy` skips
   * straight to plain copies.
   */
  mode?: CloneMode
  /** Concurrent file operations in flight. */
  concurrency?: number
}

const LINK_FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'EACCES', 'EINVAL'])

/**
 * `link` on macOS: every file in a hard-linked clone shares one inode with
 * the store, so a tool that opens-and-truncates-in-place (rather than the
 * unlink+rewrite package managers use) would corrupt the shared original.
 * APFS's `clonefile(2)` — exposed here as `fs.copyFile` with
 * `COPYFILE_FICLONE` — gives the same near-zero-cost, no-extra-disk clone as
 * a hard link (copy-on-write: data blocks are only duplicated on the first
 * write to either copy) but produces a fully independent file, so it carries
 * none of that risk. It also measured faster on this host: cloning a 36,907
 * file `node_modules` took 9.4s hard-linked vs 3.2s ficlone'd (see the macOS
 * section of docs/perf/project-open.md). `COPYFILE_FICLONE` (unlike
 * `_FORCE`) degrades to a plain copy instead of throwing when the underlying
 * volume doesn't support cloning, so requesting it outside APFS is safe, just
 * pointless — hence gating the default on `darwin` rather than requesting it
 * everywhere.
 */
export function defaultCloneMode(): CloneMode {
  return process.platform === 'darwin' ? 'ficlone' : 'link'
}

/**
 * Replicate `src` at `dst` (which must not exist yet).
 *
 * Regular files are cloned by default (see {@link defaultCloneMode}): a 40k-file
 * `node_modules` clones in a couple of seconds and costs no extra disk, versus
 * a minute for a fresh `npm install` on Windows. If the first clone/link
 * attempt fails (other volume, FAT/exFAT, restricted ACLs) the rest of the
 * tree is copied instead.
 *
 * Symlinks are recreated as symlinks (macOS `node_modules/.bin`); directories
 * are walked, never linked.
 *
 * The walk is fully async and bounded so a clone on the open path does not
 * stall the API event loop.
 */
export async function cloneTree(src: string, dst: string, opts: CloneTreeOptions = {}): Promise<CloneTreeResult> {
  const result: CloneTreeResult = { files: 0, dirs: 0, symlinks: 0, mode: opts.mode ?? defaultCloneMode() }
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
    if (result.mode === 'ficlone') {
      try {
        await fsp.copyFile(from, to, fsConstants.COPYFILE_FICLONE)
        return
      } catch (err: any) {
        if (!LINK_FALLBACK_CODES.has(err?.code)) throw err
        result.mode = 'copy'
      }
    }
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
