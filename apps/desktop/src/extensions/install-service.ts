// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import electron from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { unzipSync } from 'fflate'
import { parseExtensionManifestJson, type ShogoExtensionManifest } from './manifest'

export type ExtensionInstallSource = 'vsix' | 'open-vsx' | 'private'
export type ExtensionEnableScope = 'global' | 'workspace'

export interface InstalledExtensionRecord {
  id: string
  publisher: string
  name: string
  version: string
  displayName?: string
  description?: string
  installPath: string
  manifestPath: string
  source: ExtensionInstallSource
  installedAt: number
  updatedAt: number
  packageHash: string
  compatible: boolean
  compatibilityReason?: string
  warnings: string[]
  autoUpdate: boolean
  pendingDelete?: boolean
  restartRequired?: boolean
  manifest: ShogoExtensionManifest
}

export interface ExtensionRegistryState {
  schemaVersion: 1
  extensions: InstalledExtensionRecord[]
}

export interface ExtensionLockState {
  schemaVersion: 1
  packages: Record<string, { version: string; sha256: string; source: ExtensionInstallSource; installedAt: number }>
}

export interface ExtensionListItem extends InstalledExtensionRecord {
  enabled: boolean
  disabledGlobally: boolean
  disabledForWorkspace: boolean
}

const MAX_VSIX_FILES = 10000
const MAX_VSIX_TOTAL_BYTES = 250 * 1024 * 1024

export class ExtensionInstallService {
  readonly rootDir: string
  readonly installedDir: string
  readonly cacheDir: string
  readonly stateDir: string

  constructor(rootDir = defaultExtensionsRoot()) {
    this.rootDir = rootDir
    this.installedDir = path.join(rootDir, 'installed')
    this.cacheDir = path.join(rootDir, 'cache')
    this.stateDir = path.join(rootDir, 'state')
    this.ensureLayout()
  }

  ensureLayout(): void {
    for (const dir of [
      this.installedDir,
      path.join(this.cacheDir, 'downloads'),
      path.join(this.cacheDir, 'registry-search'),
      this.stateDir,
      path.join(this.stateDir, 'disabled-workspace'),
    ]) fs.mkdirSync(dir, { recursive: true })
    ensureJsonFile(this.registryPath(), { schemaVersion: 1, extensions: [] })
    ensureJsonFile(this.lockPath(), { schemaVersion: 1, packages: {} })
    ensureJsonFile(this.disabledGlobalPath(), [])
    ensureJsonFile(path.join(this.stateDir, 'trusted-publishers.json'), [])
  }

  listInstalled(workspaceRoot?: string): ExtensionListItem[] {
    const state = this.readRegistry()
    const disabledGlobal = new Set(this.readStringArray(this.disabledGlobalPath()))
    const disabledWorkspace = new Set(workspaceRoot ? this.readStringArray(this.disabledWorkspacePath(workspaceRoot)) : [])
    return state.extensions.map((record) => ({
      ...record,
      disabledGlobally: disabledGlobal.has(record.id),
      disabledForWorkspace: disabledWorkspace.has(record.id),
      enabled: !record.pendingDelete && !disabledGlobal.has(record.id) && !disabledWorkspace.has(record.id),
    }))
  }

  getContributions(workspaceRoot?: string): { extensions: ExtensionListItem[]; contributions: Array<{ extensionId: string; contributes: ShogoExtensionManifest['contributes'] }> } {
    const extensions = this.listInstalled(workspaceRoot)
    return {
      extensions,
      contributions: extensions
        .filter((ext) => ext.enabled && ext.compatible && ext.manifest.contributes)
        .map((ext) => ({ extensionId: ext.id, contributes: ext.manifest.contributes })),
    }
  }

  installFromVsix(vsixPath: string, source: ExtensionInstallSource = 'vsix'): InstalledExtensionRecord {
    const absoluteVsixPath = path.resolve(vsixPath)
    const packageBytes = fs.readFileSync(absoluteVsixPath)
    const packageHash = crypto.createHash('sha256').update(packageBytes).digest('hex')
    const entries = unzipSync(new Uint8Array(packageBytes))
    const entryNames = Object.keys(entries)
    if (entryNames.length === 0) throw new Error('VSIX archive is empty')
    if (entryNames.length > MAX_VSIX_FILES) throw new Error(`VSIX has too many files (${entryNames.length}; max ${MAX_VSIX_FILES})`)

    let totalBytes = 0
    for (const [entryName, entryBytes] of Object.entries(entries)) {
      validateArchiveEntryPath(entryName)
      totalBytes += entryBytes.byteLength
      if (totalBytes > MAX_VSIX_TOTAL_BYTES) throw new Error('VSIX is too large to install safely')
    }

    const packageJsonBytes = entries['extension/package.json']
    if (!packageJsonBytes) throw new Error('VSIX is missing extension/package.json')
    const packageJson = Buffer.from(packageJsonBytes).toString('utf8')
    const parsed = parseExtensionManifestJson(packageJson)
    const manifest = parsed.manifest
    const installName = `${manifest.id}-${manifest.version}`
    const installPath = path.join(this.installedDir, installName)
    const tempPath = path.join(this.installedDir, `.tmp-${installName}-${Date.now()}`)

    fs.rmSync(tempPath, { recursive: true, force: true })
    fs.mkdirSync(tempPath, { recursive: true })
    try {
      for (const [entryName, entryBytes] of Object.entries(entries)) {
        if (!entryName.startsWith('extension/') || entryName.endsWith('/')) continue
        const relPath = entryName.slice('extension/'.length)
        if (!relPath) continue
        const outPath = safeJoin(tempPath, relPath)
        fs.mkdirSync(path.dirname(outPath), { recursive: true })
        fs.writeFileSync(outPath, Buffer.from(entryBytes))
      }
      fs.rmSync(installPath, { recursive: true, force: true })
      fs.renameSync(tempPath, installPath)
    } catch (err) {
      fs.rmSync(tempPath, { recursive: true, force: true })
      throw err
    }

    const now = Date.now()
    const record: InstalledExtensionRecord = {
      id: manifest.id,
      publisher: manifest.publisher,
      name: manifest.name,
      version: manifest.version,
      displayName: manifest.displayName,
      description: manifest.description,
      installPath,
      manifestPath: path.join(installPath, 'package.json'),
      source,
      installedAt: now,
      updatedAt: now,
      packageHash,
      compatible: parsed.compatible,
      compatibilityReason: parsed.compatibilityReason,
      warnings: parsed.warnings,
      autoUpdate: source !== 'vsix',
      restartRequired: true,
      manifest,
    }

    const registry = this.readRegistry()
    const existing = registry.extensions.findIndex((ext) => ext.id === record.id)
    if (existing >= 0) registry.extensions[existing] = record
    else registry.extensions.push(record)
    this.writeRegistry(registry)

    const lock = this.readLock()
    lock.packages[record.id] = { version: record.version, sha256: packageHash, source: record.source, installedAt: now }
    this.writeLock(lock)
    return record
  }

  uninstall(id: string): { ok: true; restartRequired: boolean } {
    const registry = this.readRegistry()
    const record = registry.extensions.find((ext) => ext.id === id)
    if (!record) throw new Error(`Extension not installed: ${id}`)
    fs.rmSync(record.installPath, { recursive: true, force: true })
    registry.extensions = registry.extensions.filter((ext) => ext.id !== id)
    this.writeRegistry(registry)
    const lock = this.readLock()
    delete lock.packages[id]
    this.writeLock(lock)
    this.removeFromDisabledLists(id)
    return { ok: true, restartRequired: true }
  }

  setEnabled(id: string, enabled: boolean, scope: ExtensionEnableScope = 'global', workspaceRoot?: string): { ok: true; restartRequired: boolean } {
    const registry = this.readRegistry()
    if (!registry.extensions.some((ext) => ext.id === id)) throw new Error(`Extension not installed: ${id}`)
    const file = scope === 'workspace' ? this.disabledWorkspacePath(requiredWorkspace(workspaceRoot)) : this.disabledGlobalPath()
    const set = new Set(this.readStringArray(file))
    if (enabled) set.delete(id)
    else set.add(id)
    writeJsonAtomic(file, [...set].sort())
    this.markRestartRequired(id)
    return { ok: true, restartRequired: true }
  }

  clearRestartRequired(): void {
    const registry = this.readRegistry()
    registry.extensions = registry.extensions.map((ext) => ({ ...ext, restartRequired: false }))
    this.writeRegistry(registry)
  }

  checkUpdates(): { ok: true; updates: [] } {
    return { ok: true, updates: [] }
  }

  private markRestartRequired(id: string): void {
    const registry = this.readRegistry()
    registry.extensions = registry.extensions.map((ext) => ext.id === id ? { ...ext, restartRequired: true } : ext)
    this.writeRegistry(registry)
  }

  private removeFromDisabledLists(id: string): void {
    const global = new Set(this.readStringArray(this.disabledGlobalPath()))
    global.delete(id)
    writeJsonAtomic(this.disabledGlobalPath(), [...global].sort())
    const dir = path.join(this.stateDir, 'disabled-workspace')
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      const p = path.join(dir, file)
      const set = new Set(this.readStringArray(p))
      if (!set.delete(id)) continue
      writeJsonAtomic(p, [...set].sort())
    }
  }

  private registryPath(): string { return path.join(this.stateDir, 'extensions.json') }
  private lockPath(): string { return path.join(this.stateDir, 'extensions.lock.json') }
  private disabledGlobalPath(): string { return path.join(this.stateDir, 'disabled-global.json') }
  private disabledWorkspacePath(workspaceRoot: string): string { return path.join(this.stateDir, 'disabled-workspace', `${hashWorkspace(workspaceRoot)}.json`) }

  private readRegistry(): ExtensionRegistryState {
    return readJson(this.registryPath(), { schemaVersion: 1, extensions: [] }) as ExtensionRegistryState
  }

  private writeRegistry(state: ExtensionRegistryState): void { writeJsonAtomic(this.registryPath(), state) }

  private readLock(): ExtensionLockState {
    return readJson(this.lockPath(), { schemaVersion: 1, packages: {} }) as ExtensionLockState
  }

  private writeLock(state: ExtensionLockState): void { writeJsonAtomic(this.lockPath(), state) }

  private readStringArray(file: string): string[] {
    const value = readJson(file, [])
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  }
}

export function defaultExtensionsRoot(): string {
  return path.join(electron.app.getPath('userData'), 'extensions')
}

function validateArchiveEntryPath(entryName: string): void {
  if (!entryName.startsWith('extension/')) return
  if (entryName.includes('\\')) throw new Error(`Unsafe VSIX path: ${entryName}`)
  const rel = entryName.slice('extension/'.length)
  if (!rel) return
  safeJoin(path.join(os.tmpdir(), 'shogo-vsix-entry-root'), rel)
}

function safeJoin(root: string, relPath: string): string {
  if (path.isAbsolute(relPath)) throw new Error(`Unsafe absolute path: ${relPath}`)
  const normalized = path.normalize(relPath)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error(`Unsafe path traversal: ${relPath}`)
  const joined = path.resolve(root, normalized)
  const resolvedRoot = path.resolve(root)
  if (joined !== resolvedRoot && !joined.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Unsafe path traversal: ${relPath}`)
  return joined
}

function hashWorkspace(workspaceRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 32)
}

function requiredWorkspace(workspaceRoot?: string): string {
  if (!workspaceRoot) throw new Error('workspaceRoot is required for workspace-scoped extension enablement')
  return workspaceRoot
}

function ensureJsonFile(file: string, value: unknown): void {
  if (!fs.existsSync(file)) writeJsonAtomic(file, value)
}

function readJson(file: string, fallback: unknown): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}
