// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Node-only filesystem watcher that pushes local edits back to Shogo
 * Cloud via {@link CloudFileTransport}. Used by:
 *   - `shogo project pull --watch`        (foreground sync)
 *   - `WorkerRuntimeManager` auto-pull    (background sync alongside an
 *                                          actively running agent-runtime)
 *
 * Design notes:
 *   - Uses `node:fs.watch` recursively when available (Linux >= 20.x via
 *     `recursive: true`, macOS, Windows) — no `chokidar` dep.
 *   - Debounces a window of changes into a single batch upload to amortize
 *     presign round trips. Default 1.5s.
 *   - Skips EXCLUDED_DIRS the same way the transport does.
 *   - Best-effort: errors are logged but never crash the watcher; the
 *     caller's UI surfaces them.
 */

import { watch, type FSWatcher, statSync } from 'node:fs';
import { relative, sep, posix } from 'node:path';
import type { CloudFileTransport } from '@shogo-ai/sdk';

const DEBOUNCE_MS = 1500;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.vite', '.cache']);

export interface CloudSyncWatcherOptions {
  /** Local directory to watch. */
  rootDir: string;
  /** Transport used to push uploads. */
  transport: CloudFileTransport;
  /** Optional debounce window in ms. Default 1500. */
  debounceMs?: number;
  /** Logger. Defaults to console. */
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Called whenever a batch flushes. Useful for progress UIs / metrics. */
  onFlush?: (event: { uploaded: string[]; errors: number }) => void;
}

/** Convert an absolute or platform-native path to a forward-slash relative path. */
function toPosixRel(rootDir: string, abs: string): string {
  const rel = relative(rootDir, abs);
  if (!rel) return '';
  return rel.split(sep).join(posix.sep);
}

function isExcluded(relPath: string): boolean {
  if (!relPath) return true;
  return relPath.split('/').some((part) => EXCLUDED_DIRS.has(part));
}

export class CloudSyncWatcher {
  private readonly rootDir: string;
  private readonly transport: CloudFileTransport;
  private readonly debounceMs: number;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly onFlush?: CloudSyncWatcherOptions['onFlush'];

  private watcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private stopped = false;

  constructor(opts: CloudSyncWatcherOptions) {
    this.rootDir = opts.rootDir;
    this.transport = opts.transport;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.logger = opts.logger ?? console;
    this.onFlush = opts.onFlush;
  }

  /**
   * Begin watching. Throws if the directory can't be watched (e.g. it
   * doesn't exist). Callers should wrap in try/catch.
   */
  start(): void {
    if (this.watcher) return;
    if (this.stopped) throw new Error('CloudSyncWatcher: already stopped, build a fresh instance');

    // Some platforms / Node versions don't support `recursive: true`. Fall
    // back to a non-recursive watch on the root + per-discovered-subdir
    // watches in that case. For Linux >= 20 / macOS / Windows, the
    // recursive variant is much cheaper and we use it by default.
    try {
      this.watcher = watch(this.rootDir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        this.handleEvent(String(filename));
      });
    } catch (err: any) {
      this.logger.warn(`[CloudSyncWatcher] recursive watch failed (${err?.message ?? err}); falling back to root-only watch.`);
      this.watcher = watch(this.rootDir, (eventType, filename) => {
        if (!filename) return;
        this.handleEvent(String(filename));
      });
    }
  }

  /** Stop watching and flush any pending uploads. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* already closed */
      }
      this.watcher = null;
    }
    // Final flush so we don't lose the last edits made before SIGINT.
    if (this.pending.size > 0) {
      await this.flush();
    }
  }

  private handleEvent(filenameLike: string): void {
    if (this.stopped) return;
    const rel = filenameLike.split(sep).join(posix.sep);
    if (isExcluded(rel)) return;
    // Ignore directory events — we only push file content. A directory rename
    // shows up later as individual file events when their content is touched.
    try {
      const abs = `${this.rootDir}/${rel}`;
      const stat = statSync(abs);
      if (stat.isDirectory()) return;
    } catch {
      // File was deleted between the event firing and the stat — emit a
      // delete intent. We track these as `null` markers in `pending` but
      // since the transport doesn't have a "push pending deletes" mode
      // we just drop them; the next `--delete-remote` push will clean
      // them up. Documented behavior.
      return;
    }
    this.pending.add(rel);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      // Re-schedule so we don't drop edits that arrived during the upload.
      this.scheduleFlush();
      return;
    }
    if (this.pending.size === 0) return;
    this.flushing = true;
    const batch = Array.from(this.pending);
    this.pending.clear();
    try {
      const stats = await this.transport.uploadFiles(batch);
      this.onFlush?.({ uploaded: batch, errors: stats.errors.length });
      if (stats.errors.length > 0) {
        for (const err of stats.errors) {
          this.logger.warn(`[CloudSyncWatcher] upload ${err.path}: ${err.message}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[CloudSyncWatcher] flush failed: ${err?.message ?? err}`);
      // Re-queue so we'll retry on the next tick.
      for (const p of batch) this.pending.add(p);
      this.scheduleFlush();
    } finally {
      this.flushing = false;
    }
  }
}

// Re-export for tests
export { toPosixRel as _toPosixRel, isExcluded as _isExcluded };
