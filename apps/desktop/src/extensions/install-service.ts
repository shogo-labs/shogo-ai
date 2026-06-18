// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import electron from 'electron'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { unzipSync } from 'fflate'
import { parseExtensionManifestJson, type ShogoExtensionManifest } from './manifest'
import { hashWorkspace } from './workspace-id'

export type ExtensionInstallSource = 'vsix' | 'open-vsx' | 'private'
export type ExtensionEnableScope = 'global' | 'workspace'

export interface InstalledExtensionRecord {
  id: string
  publisher: string
  name: string
  version: string
  displayName?: string
  description?: string
  iconUrl?: string
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

export interface TrustedPublisherRecord {
  publisher: string
  publisherKey: string
  trustedAt: number
  source: 'user' | 'policy'
}

export interface WorkspaceTrustRecord {
  workspaceRoot: string
  workspaceKey: string
  trusted: boolean
  trustedAt?: number
  source: 'user' | 'policy'
}

export interface WorkspaceTrustState {
  workspaceRoot?: string
  workspaceKey?: string
  trusted: boolean
  restrictedMode: boolean
  source?: 'user' | 'policy'
  trustedAt?: number
}

export type RestrictedModeSupport = 'full' | 'limited' | 'unsupported'
export type ExtensionSupportStatus = 'supported' | 'partial' | 'unsupported' | 'requiresRuntime'
export type ExtensionCapabilityKind = 'declarative' | 'commands' | 'views' | 'formatter' | 'linter' | 'debugger' | 'terminal' | 'task' | 'scm' | 'typescriptServerPlugin'
export type ExtensionUsableEntryPointKind = 'command' | 'view' | 'viewContainer' | 'startupActivation'

export interface ExtensionUsableEntryPoint {
  kind: ExtensionUsableEntryPointKind
  id: string
  label: string
  detail?: string
}

export interface ExtensionPackageInspection {
  manifest: ShogoExtensionManifest
  compatible: boolean
  compatibilityReason?: string
  warnings: string[]
  packageHash: string
}

export interface ExtensionListItem extends InstalledExtensionRecord {
  enabled: boolean
  disabledGlobally: boolean
  disabledForWorkspace: boolean
  trustedPublisher: boolean
  trustedPublisherAt?: number
  workspaceTrusted: boolean
  restrictedMode: boolean
  restrictedModeSupport: RestrictedModeSupport
  disabledByRestrictedMode: boolean
  restrictedModeReason?: string
  usableEntryPoints: ExtensionUsableEntryPoint[]
  hasUsableEntryPoint: boolean
  unsupportedSurfaceMessage?: string
  supportStatus: ExtensionSupportStatus
  supportStatusMessage: string
  capabilityKinds: ExtensionCapabilityKind[]
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
    ensureJsonFile(this.workspaceTrustPath(), [])
  }

  listInstalled(workspaceRoot?: string): ExtensionListItem[] {
    const state = this.readRegistry()
    const disabledGlobal = new Set(this.readStringArray(this.disabledGlobalPath()))
    const disabledWorkspace = new Set(workspaceRoot ? this.readStringArray(this.disabledWorkspacePath(workspaceRoot)) : [])
    const workspaceTrust = this.getWorkspaceTrust(workspaceRoot)
    const trustedPublishers = new Map(this.listTrustedPublishers().map((record) => [record.publisherKey, record]))
    return state.extensions.map((record) => {
      const trusted = trustedPublishers.get(publisherKey(record.publisher))
      const restrictedModeSupport = getRestrictedModeSupport(record.manifest)
      const disabledByRestrictedMode = workspaceTrust.restrictedMode && restrictedModeSupport === 'unsupported'
      const usableEntryPoints = getUsableEntryPoints(record.manifest)
      const capabilityKinds = getCapabilityKinds(record.manifest)
      const support = getSupportAssessment(record, usableEntryPoints, capabilityKinds)
      return {
        ...record,
        iconUrl: installedIconUrl(record),
        disabledGlobally: disabledGlobal.has(record.id),
        disabledForWorkspace: disabledWorkspace.has(record.id),
        enabled: !record.pendingDelete && !disabledGlobal.has(record.id) && !disabledWorkspace.has(record.id) && !disabledByRestrictedMode,
        trustedPublisher: !!trusted,
        trustedPublisherAt: trusted?.trustedAt,
        workspaceTrusted: workspaceTrust.trusted,
        restrictedMode: workspaceTrust.restrictedMode,
        restrictedModeSupport,
        disabledByRestrictedMode,
        restrictedModeReason: disabledByRestrictedMode
          ? 'Blocked in Restricted Mode because this extension does not declare support for untrusted workspaces.'
          : undefined,
        usableEntryPoints,
        hasUsableEntryPoint: usableEntryPoints.length > 0,
        unsupportedSurfaceMessage: support.unsupportedSurfaceMessage,
        supportStatus: support.status,
        supportStatusMessage: support.message,
        capabilityKinds,
      }
    })
  }

  /**
   * Integrity check run before the extension host loads an extension. Confirms
   * the registry record has not been tampered with out-of-band:
   *   - the install path is confined to the managed installed dir
   *   - the recorded package hash matches the (separately written) lockfile
   *   - the declared `main` entry resolves inside the install dir
   * Returns `{ ok: false, reason }` so the host can skip + diagnose rather than
   * loading an unverified extension. An attacker who edits only registry.json
   * (e.g. to repoint installPath at a malicious dir or bump a hash) is caught
   * because the lockfile is a distinct file with the authoritative hash.
   */
  verifyIntegrity(record: InstalledExtensionRecord): { ok: boolean; reason?: string } {
    const installPath = path.resolve(record.installPath)
    const installedRoot = path.resolve(this.installedDir)
    if (installPath !== installedRoot && !installPath.startsWith(installedRoot + path.sep)) {
      return { ok: false, reason: `install path escapes managed directory: ${record.installPath}` }
    }
    if (!fs.existsSync(installPath)) {
      return { ok: false, reason: `install path does not exist: ${record.installPath}` }
    }
    const lockEntry = this.readLock().packages[record.id]
    if (!lockEntry) {
      return { ok: false, reason: `no lockfile entry for ${record.id}` }
    }
    if (lockEntry.sha256 !== record.packageHash) {
      return { ok: false, reason: `package hash mismatch for ${record.id}` }
    }
    if (lockEntry.version !== record.version) {
      return { ok: false, reason: `version mismatch for ${record.id} (lock ${lockEntry.version} vs registry ${record.version})` }
    }
    if (record.manifest.main) {
      const mainPath = path.resolve(installPath, record.manifest.main)
      if (mainPath !== installPath && !mainPath.startsWith(installPath + path.sep)) {
        return { ok: false, reason: `main entry escapes install dir: ${record.manifest.main}` }
      }
    }
    return { ok: true }
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

  inspectVsix(vsixPath: string): ExtensionPackageInspection {
    const absoluteVsixPath = path.resolve(vsixPath)
    const packageBytes = fs.readFileSync(absoluteVsixPath)
    const packageHash = crypto.createHash('sha256').update(packageBytes).digest('hex')
    const { entries } = readValidatedVsixEntries(packageBytes)
    const packageJsonBytes = entries['extension/package.json']
    if (!packageJsonBytes) throw new Error('VSIX is missing extension/package.json')
    const packageJson = Buffer.from(packageJsonBytes).toString('utf8')
    const parsed = parseExtensionManifestJson(packageJson)
    return {
      manifest: parsed.manifest,
      compatible: parsed.compatible,
      compatibilityReason: parsed.compatibilityReason,
      warnings: parsed.warnings,
      packageHash,
    }
  }

  listTrustedPublishers(): TrustedPublisherRecord[] {
    return normalizeTrustedPublisherRecords(readJson(this.trustedPublishersPath(), []))
  }

  isPublisherTrusted(publisher: string): boolean {
    const key = publisherKey(publisher)
    return this.listTrustedPublishers().some((record) => record.publisherKey === key)
  }

  trustPublisher(publisher: string, source: TrustedPublisherRecord['source'] = 'user'): TrustedPublisherRecord {
    const trimmed = publisher.trim()
    if (!trimmed) throw new Error('Publisher is required')
    const key = publisherKey(trimmed)
    const records = this.listTrustedPublishers()
    const existing = records.find((record) => record.publisherKey === key)
    if (existing) return existing
    const record: TrustedPublisherRecord = { publisher: trimmed, publisherKey: key, trustedAt: Date.now(), source }
    writeJsonAtomic(this.trustedPublishersPath(), [...records, record].sort((a, b) => a.publisherKey.localeCompare(b.publisherKey)))
    return record
  }

  getWorkspaceTrust(workspaceRoot?: string): WorkspaceTrustState {
    if (!workspaceRoot) return { trusted: true, restrictedMode: false }
    const normalized = path.resolve(workspaceRoot)
    const key = hashWorkspace(normalized)
    const record = this.listWorkspaceTrustRecords().find((item) => item.workspaceKey === key)
    const trusted = record?.trusted === true
    return {
      workspaceRoot: normalized,
      workspaceKey: key,
      trusted,
      restrictedMode: !trusted,
      source: record?.source,
      trustedAt: record?.trustedAt,
    }
  }

  trustWorkspace(workspaceRoot: string, source: WorkspaceTrustRecord['source'] = 'user'): WorkspaceTrustRecord {
    const normalized = path.resolve(requiredWorkspace(workspaceRoot))
    const key = hashWorkspace(normalized)
    const records = this.listWorkspaceTrustRecords().filter((record) => record.workspaceKey !== key)
    const record: WorkspaceTrustRecord = { workspaceRoot: normalized, workspaceKey: key, trusted: true, trustedAt: Date.now(), source }
    writeJsonAtomic(this.workspaceTrustPath(), [...records, record].sort((a, b) => a.workspaceRoot.localeCompare(b.workspaceRoot)))
    return record
  }

  installFromVsix(vsixPath: string, source: ExtensionInstallSource = 'vsix', metadata: { iconUrl?: string } = {}): InstalledExtensionRecord {
    const absoluteVsixPath = path.resolve(vsixPath)
    const packageBytes = fs.readFileSync(absoluteVsixPath)
    const packageHash = crypto.createHash('sha256').update(packageBytes).digest('hex')
    const { entries } = readValidatedVsixEntries(packageBytes)

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
      iconUrl: metadata.iconUrl,
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
  private trustedPublishersPath(): string { return path.join(this.stateDir, 'trusted-publishers.json') }
  private workspaceTrustPath(): string { return path.join(this.stateDir, 'workspace-trust.json') }
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

  private listWorkspaceTrustRecords(): WorkspaceTrustRecord[] {
    return normalizeWorkspaceTrustRecords(readJson(this.workspaceTrustPath(), []))
  }
}

export function defaultExtensionsRoot(): string {
  return path.join(electron.app.getPath('userData'), 'extensions')
}

function installedIconUrl(record: InstalledExtensionRecord): string | undefined {
  if (record.iconUrl) return record.iconUrl
  const icon = record.manifest.icon
  if (!icon) return undefined
  if (/^https?:\/\//i.test(icon) || icon.startsWith('data:')) return icon
  try {
    const iconPath = safeJoin(record.installPath, icon)
    if (!fs.existsSync(iconPath)) return undefined
    const stat = fs.statSync(iconPath)
    if (stat.size > 2 * 1024 * 1024) return undefined
    return `data:${iconMimeType(iconPath)};base64,${fs.readFileSync(iconPath).toString('base64')}`
  } catch {
    return undefined
  }
}

function iconMimeType(file: string): string {
  switch (path.extname(file).toLowerCase()) {
    case '.svg': return 'image/svg+xml'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'image/png'
  }
}

function readValidatedVsixEntries(packageBytes: Buffer): { entries: Record<string, Uint8Array> } {
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
  return { entries }
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

function publisherKey(publisher: string): string {
  return publisher.trim().toLowerCase()
}

function normalizeTrustedPublisherRecords(value: unknown): TrustedPublisherRecord[] {
  if (!Array.isArray(value)) return []
  const records = new Map<string, TrustedPublisherRecord>()
  for (const item of value) {
    if (typeof item === 'string') {
      const publisher = item.trim()
      if (!publisher) continue
      const key = publisherKey(publisher)
      records.set(key, { publisher, publisherKey: key, trustedAt: 0, source: 'user' })
      continue
    }
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const publisher = typeof raw.publisher === 'string' ? raw.publisher.trim() : ''
    if (!publisher) continue
    const key = typeof raw.publisherKey === 'string' && raw.publisherKey.trim()
      ? raw.publisherKey.trim().toLowerCase()
      : publisherKey(publisher)
    records.set(key, {
      publisher,
      publisherKey: key,
      trustedAt: typeof raw.trustedAt === 'number' && Number.isFinite(raw.trustedAt) ? raw.trustedAt : 0,
      source: raw.source === 'policy' ? 'policy' : 'user',
    })
  }
  return [...records.values()].sort((a, b) => a.publisherKey.localeCompare(b.publisherKey))
}

function normalizeWorkspaceTrustRecords(value: unknown): WorkspaceTrustRecord[] {
  if (!Array.isArray(value)) return []
  const records = new Map<string, WorkspaceTrustRecord>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    const workspaceRoot = typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim()
      ? path.resolve(raw.workspaceRoot)
      : ''
    if (!workspaceRoot) continue
    const workspaceKey = typeof raw.workspaceKey === 'string' && raw.workspaceKey.trim()
      ? raw.workspaceKey.trim()
      : hashWorkspace(workspaceRoot)
    records.set(workspaceKey, {
      workspaceRoot,
      workspaceKey,
      trusted: raw.trusted === true,
      trustedAt: typeof raw.trustedAt === 'number' && Number.isFinite(raw.trustedAt) ? raw.trustedAt : undefined,
      source: raw.source === 'policy' ? 'policy' : 'user',
    })
  }
  return [...records.values()].sort((a, b) => a.workspaceRoot.localeCompare(b.workspaceRoot))
}

function getUsableEntryPoints(manifest: ShogoExtensionManifest): ExtensionUsableEntryPoint[] {
  const entryPoints: ExtensionUsableEntryPoint[] = []
  for (const command of manifest.contributes?.commands ?? []) {
    if (!command.command) continue
    entryPoints.push({
      kind: 'command',
      id: command.command,
      label: command.category ? `${command.category}: ${command.title}` : command.title,
      detail: command.command,
    })
  }
  const activitybarContainers = new Map((manifest.contributes?.viewsContainers?.activitybar ?? []).map((container) => [container.id, container]))
  const panelContainers = new Map((manifest.contributes?.viewsContainers?.panel ?? []).map((container) => [container.id, container]))
  const supportedContainers = new Set([...activitybarContainers.keys(), ...panelContainers.keys()])
  for (const [containerId, views] of Object.entries(manifest.contributes?.views ?? {})) {
    if (!supportedContainers.has(containerId)) continue
    for (const view of views ?? []) {
      if (!view.id) continue
      entryPoints.push({ kind: 'view', id: view.id, label: view.name || view.id, detail: containerId })
    }
  }
  for (const [containerId, container] of activitybarContainers) {
    if (containerId && (manifest.contributes?.views?.[containerId]?.length ?? 0) > 0) entryPoints.push({ kind: 'viewContainer', id: containerId, label: container.title || containerId, detail: 'Activity Bar' })
  }
  for (const [containerId, container] of panelContainers) {
    if (containerId && (manifest.contributes?.views?.[containerId]?.length ?? 0) > 0) entryPoints.push({ kind: 'viewContainer', id: containerId, label: container.title || containerId, detail: 'Panel' })
  }
  if ((manifest.main || manifest.browser) && manifest.activationEvents?.some((event) => event === '*' || event === 'onStartupFinished')) {
    entryPoints.push({ kind: 'startupActivation', id: 'onStartupFinished', label: 'Activate extension', detail: 'Runs startup activation and refreshes runtime contributions' })
  }
  return entryPoints
}

function getCapabilityKinds(manifest: ShogoExtensionManifest): ExtensionCapabilityKind[] {
  const contributes = manifest.contributes ?? {}
  const kinds = new Set<ExtensionCapabilityKind>()
  if ((contributes.commands?.length ?? 0) > 0) kinds.add('commands')
  if (Object.keys(contributes.views ?? {}).length > 0 || (contributes.viewsContainers?.activitybar?.length ?? 0) > 0 || (contributes.viewsContainers?.panel?.length ?? 0) > 0) kinds.add('views')
  if ((contributes.languages?.length ?? 0) > 0 || (contributes.grammars?.length ?? 0) > 0 || (contributes.snippets?.length ?? 0) > 0 || (contributes.themes?.length ?? 0) > 0 || (contributes.iconThemes?.length ?? 0) > 0 || (contributes.productIconThemes?.length ?? 0) > 0 || (contributes.jsonValidation?.length ?? 0) > 0) kinds.add('declarative')
  if ((contributes.debuggers?.length ?? 0) > 0 || (contributes.breakpoints?.length ?? 0) > 0) kinds.add('debugger')
  if ((contributes.taskDefinitions?.length ?? 0) > 0) kinds.add('task')
  if (contributes.terminal) kinds.add('terminal')
  if (Array.isArray((contributes as Record<string, unknown>).typescriptServerPlugins)) kinds.add('typescriptServerPlugin')
  if (extensionHasFormatterSurface(manifest)) kinds.add('formatter')
  if (extensionHasLinterSurface(manifest)) kinds.add('linter')
  if (extensionHasScmSurface(manifest)) kinds.add('scm')
  return [...kinds]
}

function getSupportAssessment(record: InstalledExtensionRecord, entryPoints: ExtensionUsableEntryPoint[], capabilityKinds: ExtensionCapabilityKind[]): { status: ExtensionSupportStatus; message: string; unsupportedSurfaceMessage?: string } {
  const extensionId = record.manifest.id.toLowerCase()
  if (extensionId === 'esbenp.prettier-vscode' || record.manifest.name.toLowerCase().includes('prettier')) {
    return { status: 'requiresRuntime', message: 'Requires formatter provider support; installed but not active yet.', unsupportedSurfaceMessage: 'Prettier installs successfully, but formatting requires vscode.languages formatter-provider support and a Monaco formatting bridge before it can change files.' }
  }
  if (extensionId === 'dbaeumer.vscode-eslint' || record.manifest.name.toLowerCase().includes('eslint')) {
    return { status: 'requiresRuntime', message: 'Requires LSP/diagnostics support; installed but not active yet.', unsupportedSurfaceMessage: 'ESLint installs successfully, but linting requires language-client, diagnostics, Problems, and code-action support before it can report or fix issues.' }
  }
  if (extensionId === 'mhutchie.git-graph' || record.manifest.name.toLowerCase().includes('git-graph')) {
    return { status: 'partial', message: 'Requires webview + Git/SCM APIs; command may fail until runtime support is complete.', unsupportedSurfaceMessage: 'Git Graph exposes commands, but it depends on fuller webview, text-document-content, and Git/SCM API support. If the command fails, check Host Diagnostics for the exact missing runtime API.' }
  }
  if (!record.compatible) {
    return { status: 'unsupported', message: record.compatibilityReason ?? 'Requires a newer VS Code API than Shogo currently supports.', unsupportedSurfaceMessage: record.compatibilityReason }
  }
  if (capabilityKinds.some((kind) => kind === 'formatter' || kind === 'linter' || kind === 'debugger' || kind === 'task' || kind === 'terminal' || kind === 'typescriptServerPlugin')) {
    return { status: entryPoints.length > 0 ? 'partial' : 'requiresRuntime', message: 'Requires deeper VS Code runtime support for some contributed features.', unsupportedSurfaceMessage: getUnsupportedSurfaceMessage(record) }
  }
  if (capabilityKinds.includes('declarative') && capabilityKinds.length === 1) {
    return { status: 'requiresRuntime', message: 'Declarative contribution installed; themes, grammars, snippets, and schemas are not wired into the editor yet.', unsupportedSurfaceMessage: 'This extension contributes declarative editor assets, but Shogo does not load themes, grammars, snippets, icon themes, or JSON validation schemas into Monaco yet.' }
  }
  if (entryPoints.length > 0) {
    return { status: capabilityKinds.includes('views') ? 'partial' : 'supported', message: capabilityKinds.includes('views') ? 'Commands/views are reachable; complex VS Code APIs may still be partial.' : 'Commands are reachable from Use, Command Palette, and extension details.' }
  }
  return { status: 'unsupported', message: 'No command, view, startup activation, or currently wired declarative surface is reachable.', unsupportedSurfaceMessage: getUnsupportedSurfaceMessage(record) }
}

function extensionHasFormatterSurface(manifest: ShogoExtensionManifest): boolean {
  const id = manifest.id.toLowerCase()
  const name = manifest.name.toLowerCase()
  const categories = (manifest.categories ?? []).map((category) => category.toLowerCase())
  const commands = (manifest.contributes?.commands ?? []).map((command) => `${command.command} ${command.title}`.toLowerCase())
  return id.includes('prettier') || name.includes('prettier') || categories.includes('formatters') || commands.some((command) => command.includes('format'))
}

function extensionHasLinterSurface(manifest: ShogoExtensionManifest): boolean {
  const id = manifest.id.toLowerCase()
  const name = manifest.name.toLowerCase()
  const commands = (manifest.contributes?.commands ?? []).map((command) => `${command.command} ${command.title}`.toLowerCase())
  return id.includes('eslint') || name.includes('eslint') || commands.some((command) => command.includes('lint') || command.includes('fix'))
}

function extensionHasScmSurface(manifest: ShogoExtensionManifest): boolean {
  const menus = Object.keys(manifest.contributes?.menus ?? {}).map((menu) => menu.toLowerCase())
  const commands = (manifest.contributes?.commands ?? []).map((command) => `${command.command} ${command.title}`.toLowerCase())
  return menus.some((menu) => menu.includes('scm')) || commands.some((command) => command.includes('git') || command.includes('source control'))
}

function getUnsupportedSurfaceMessage(record: InstalledExtensionRecord): string {
  const unsupportedContributionPoints = record.warnings
    .map((warning) => /^Unsupported contribution point: (.+)$/.exec(warning)?.[1])
    .filter((value): value is string => !!value)
  if (unsupportedContributionPoints.length > 0) {
    return `Installed, but Shogo cannot render this extension's declared surface yet: ${unsupportedContributionPoints.join(', ')}. No command, view, status item, or webview entry point is currently reachable.`
  }
  const contributedViewContainers = [
    ...(record.manifest.contributes?.viewsContainers?.activitybar ?? []),
    ...(record.manifest.contributes?.viewsContainers?.panel ?? []),
  ]
  if (contributedViewContainers.length > 0) {
    return 'Installed, but its contributed view container has no reachable views in Shogo yet. Add commands or views under an Activity Bar/Panel container to make it usable.'
  }
  const viewContainerIds = new Set(contributedViewContainers.map((container) => container.id))
  const unsupportedViews = Object.keys(record.manifest.contributes?.views ?? {}).filter((containerId) => !viewContainerIds.has(containerId))
  if (unsupportedViews.length > 0) {
    return `Installed, but its views target unsupported or unrendered containers: ${unsupportedViews.join(', ')}. No view entry point is currently reachable.`
  }
  if (!record.manifest.main && !record.manifest.browser) {
    return 'Installed, but this package does not declare a runtime entry point or Shogo-renderable commands/views. It is not currently usable from the IDE.'
  }
  return 'Installed, but no command, view, status item, or webview entry point is reachable yet. The manifest does not declare a Shogo-renderable surface.'
}

function getRestrictedModeSupport(manifest: ShogoExtensionManifest): RestrictedModeSupport {
  const capability = manifest.capabilities?.untrustedWorkspaces
  if (capability === true) return 'full'
  if (capability === false || capability === undefined) return 'unsupported'
  if (typeof capability === 'object') {
    if (capability.supported === true) return 'full'
    if (capability.supported === 'limited') return 'limited'
  }
  return 'unsupported'
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
