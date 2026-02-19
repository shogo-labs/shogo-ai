/**
 * FileSyncManager — local-first file sync for desktop agent workspaces.
 *
 * Watches ~/shogo-agents/{projectId}/ for changes and syncs workspace
 * files to the cloud API via the existing file endpoints:
 *   GET  /api/projects/{id}/files      — list cloud files
 *   GET  /api/projects/{id}/files/*    — read a cloud file
 *   PUT  /api/projects/{id}/files/*    — write a cloud file
 *
 * Sync is optional and can be toggled per project.
 * Local files are always the source of truth; conflicts use last-write-wins
 * with local preference.
 */

import { watch, type FSWatcher } from 'fs'
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  stat,
  access,
} from 'fs/promises'
import { join, relative } from 'path'
import { createHash } from 'crypto'
import { session } from 'electron'

// ─── Types ─────────────────────────────────────────────────────────

export type SyncState = 'idle' | 'syncing' | 'error' | 'disabled'

export interface SyncStatus {
  state: SyncState
  lastSyncedAt: number | null
  fileCount: number
  error?: string
}

interface ManifestEntry {
  hash: string
  lastSynced: number
  size: number
}

type SyncManifest = Record<string, ManifestEntry>

interface ProjectSync {
  projectId: string
  localDir: string
  enabled: boolean
  watcher: FSWatcher | null
  status: SyncStatus
  manifest: SyncManifest
  debounceTimer: ReturnType<typeof setTimeout> | null
  pendingFiles: Set<string>
}

// ─── Constants ─────────────────────────────────────────────────────

const SYNC_DEBOUNCE_MS = 3_000
const MANIFEST_FILE = '.sync-manifest.json'

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.vite', '.cache',
])

const EXCLUDED_FILES = new Set([MANIFEST_FILE])

// ─── Class ─────────────────────────────────────────────────────────

export class FileSyncManager {
  private projects = new Map<string, ProjectSync>()
  private _apiUrl = 'http://localhost:8002'
  private statusListeners: ((projectId: string, status: SyncStatus) => void)[] = []

  setApiUrl(url: string): void {
    this._apiUrl = url
  }

  // ── Listener API ───────────────────────────────────────────────

  onStatus(listener: (projectId: string, status: SyncStatus) => void): () => void {
    this.statusListeners.push(listener)
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== listener)
    }
  }

  private emitStatus(projectId: string, status: SyncStatus): void {
    for (const listener of this.statusListeners) {
      try { listener(projectId, status) } catch { /* ignore */ }
    }
  }

  // ── Enable / Disable ──────────────────────────────────────────

  enableSync(projectId: string, localDir: string): void {
    let ps = this.projects.get(projectId)
    if (!ps) {
      ps = this.createProjectSync(projectId, localDir)
      this.projects.set(projectId, ps)
    }
    ps.enabled = true
    ps.status.state = 'idle'
    this.emitStatus(projectId, ps.status)
    this.startWatching(ps)
  }

  disableSync(projectId: string): void {
    const ps = this.projects.get(projectId)
    if (!ps) return
    ps.enabled = false
    ps.status.state = 'disabled'
    this.stopWatching(ps)
    this.emitStatus(projectId, ps.status)
  }

  getSyncStatus(projectId: string): SyncStatus {
    return (
      this.projects.get(projectId)?.status ?? {
        state: 'disabled',
        lastSyncedAt: null,
        fileCount: 0,
      }
    )
  }

  // ── Manual triggers ───────────────────────────────────────────

  async triggerSync(projectId: string): Promise<void> {
    const ps = this.projects.get(projectId)
    if (!ps || !ps.enabled) return
    await this.pushToCloud(ps)
  }

  async pullFromCloud(projectId: string): Promise<void> {
    const ps = this.projects.get(projectId)
    if (!ps || !ps.enabled) return
    await this.pullCloudFiles(ps)
  }

  // ── Teardown ──────────────────────────────────────────────────

  stopAll(): void {
    for (const ps of this.projects.values()) {
      this.stopWatching(ps)
    }
    this.projects.clear()
  }

  // ── Internal: project sync bookkeeping ────────────────────────

  private createProjectSync(projectId: string, localDir: string): ProjectSync {
    return {
      projectId,
      localDir,
      enabled: false,
      watcher: null,
      status: { state: 'disabled', lastSyncedAt: null, fileCount: 0 },
      manifest: {},
      debounceTimer: null,
      pendingFiles: new Set(),
    }
  }

  // ── Internal: file watching ───────────────────────────────────

  private startWatching(ps: ProjectSync): void {
    if (ps.watcher) return

    try {
      ps.watcher = watch(ps.localDir, { recursive: true }, (_event, filename) => {
        if (!filename || this.shouldExclude(filename)) return
        ps.pendingFiles.add(filename)
        this.schedulePush(ps)
      })

      ps.watcher.on('error', () => {
        this.stopWatching(ps)
      })
    } catch {
      // Directory may not exist yet — that's fine
    }
  }

  private stopWatching(ps: ProjectSync): void {
    if (ps.watcher) {
      ps.watcher.close()
      ps.watcher = null
    }
    if (ps.debounceTimer) {
      clearTimeout(ps.debounceTimer)
      ps.debounceTimer = null
    }
  }

  private schedulePush(ps: ProjectSync): void {
    if (ps.debounceTimer) clearTimeout(ps.debounceTimer)
    ps.debounceTimer = setTimeout(() => {
      if (ps.pendingFiles.size > 0) {
        this.pushToCloud(ps).catch((err) => {
          console.error(`[FileSyncManager] Push failed for ${ps.projectId}:`, err)
        })
      }
    }, SYNC_DEBOUNCE_MS)
  }

  // ── Internal: push local → cloud ─────────────────────────────

  private async pushToCloud(ps: ProjectSync): Promise<void> {
    if (!ps.enabled) return

    ps.status.state = 'syncing'
    this.emitStatus(ps.projectId, ps.status)

    try {
      const localFiles = await this.listLocalFiles(ps.localDir)
      const cookie = await this.getSessionCookie()
      let uploaded = 0

      for (const filePath of localFiles) {
        const fullPath = join(ps.localDir, filePath)
        let content: string
        try {
          content = await readFile(fullPath, 'utf-8')
        } catch {
          continue
        }

        const hash = this.hashContent(content)
        const existing = ps.manifest[filePath]

        if (existing && existing.hash === hash) continue

        const res = await fetch(
          `${this._apiUrl}/api/projects/${ps.projectId}/files/${filePath}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ content }),
          },
        )

        if (res.ok) {
          ps.manifest[filePath] = { hash, lastSynced: Date.now(), size: content.length }
          uploaded++
        }
      }

      ps.pendingFiles.clear()
      ps.status.state = 'idle'
      ps.status.lastSyncedAt = Date.now()
      ps.status.fileCount = localFiles.length
      ps.status.error = undefined

      await this.saveManifest(ps)
      if (uploaded > 0) {
        console.log(`[FileSyncManager] Pushed ${uploaded} files for ${ps.projectId}`)
      }
    } catch (err: any) {
      ps.status.state = 'error'
      ps.status.error = err.message
    }

    this.emitStatus(ps.projectId, ps.status)
  }

  // ── Internal: pull cloud → local ─────────────────────────────

  private async pullCloudFiles(ps: ProjectSync): Promise<void> {
    if (!ps.enabled) return

    ps.status.state = 'syncing'
    this.emitStatus(ps.projectId, ps.status)

    try {
      const cookie = await this.getSessionCookie()
      const listRes = await fetch(
        `${this._apiUrl}/api/projects/${ps.projectId}/files`,
        { headers: { Cookie: cookie } },
      )

      if (!listRes.ok) throw new Error(`List files failed (${listRes.status})`)

      const { files } = (await listRes.json()) as {
        files: { path: string; type: string }[]
      }

      let downloaded = 0

      for (const file of files) {
        if (file.type !== 'file') continue

        const localPath = join(ps.localDir, file.path)
        const localHash = await this.hashLocalFile(localPath)

        const fileRes = await fetch(
          `${this._apiUrl}/api/projects/${ps.projectId}/files/${file.path}`,
          { headers: { Cookie: cookie } },
        )
        if (!fileRes.ok) continue

        const contentType = fileRes.headers.get('content-type') || ''
        let cloudContent: string

        if (contentType.includes('application/json')) {
          const data = (await fileRes.json()) as { content: string }
          cloudContent = data.content
        } else {
          cloudContent = await fileRes.text()
        }

        const cloudHash = this.hashContent(cloudContent)

        // Skip if local already matches cloud
        if (localHash === cloudHash) {
          ps.manifest[file.path] = { hash: cloudHash, lastSynced: Date.now(), size: cloudContent.length }
          continue
        }

        // Local-wins: skip download if local has uncommitted changes
        const manifestEntry = ps.manifest[file.path]
        if (localHash && manifestEntry && localHash !== manifestEntry.hash) {
          continue
        }

        await mkdir(join(ps.localDir, file.path, '..'), { recursive: true }).catch(() => {})
        await writeFile(localPath, cloudContent, 'utf-8')
        ps.manifest[file.path] = { hash: cloudHash, lastSynced: Date.now(), size: cloudContent.length }
        downloaded++
      }

      ps.status.state = 'idle'
      ps.status.lastSyncedAt = Date.now()
      ps.status.fileCount = files.filter((f) => f.type === 'file').length
      ps.status.error = undefined

      await this.saveManifest(ps)
      if (downloaded > 0) {
        console.log(`[FileSyncManager] Pulled ${downloaded} files for ${ps.projectId}`)
      }
    } catch (err: any) {
      ps.status.state = 'error'
      ps.status.error = err.message
    }

    this.emitStatus(ps.projectId, ps.status)
  }

  // ── Internal: filesystem helpers ──────────────────────────────

  private shouldExclude(filePath: string): boolean {
    if (EXCLUDED_FILES.has(filePath)) return true
    const parts = filePath.split('/')
    return parts.some((p) => EXCLUDED_DIRS.has(p))
  }

  private async listLocalFiles(dir: string, base = ''): Promise<string[]> {
    const results: string[] = []

    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return results
    }

    for (const entry of entries) {
      const relPath = base ? `${base}/${entry.name}` : entry.name
      if (this.shouldExclude(relPath)) continue

      if (entry.isDirectory()) {
        const sub = await this.listLocalFiles(join(dir, entry.name), relPath)
        results.push(...sub)
      } else {
        results.push(relPath)
      }
    }

    return results
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  private async hashLocalFile(filePath: string): Promise<string | null> {
    try {
      const content = await readFile(filePath, 'utf-8')
      return this.hashContent(content)
    } catch {
      return null
    }
  }

  private async saveManifest(ps: ProjectSync): Promise<void> {
    try {
      const manifestPath = join(ps.localDir, MANIFEST_FILE)
      await writeFile(manifestPath, JSON.stringify(ps.manifest, null, 2), 'utf-8')
    } catch {
      // Best-effort
    }
  }

  private async loadManifest(ps: ProjectSync): Promise<void> {
    try {
      const manifestPath = join(ps.localDir, MANIFEST_FILE)
      const data = await readFile(manifestPath, 'utf-8')
      ps.manifest = JSON.parse(data)
    } catch {
      ps.manifest = {}
    }
  }

  // ── Internal: auth ────────────────────────────────────────────

  private async getSessionCookie(): Promise<string> {
    const cookies = await session.defaultSession.cookies.get({ url: this._apiUrl })
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  }
}
