// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import path from 'path'

export const SHOGO_VSCODE_COMPATIBILITY = '1.80.0'

// ─── Explicit supported-API surface ──────────────────────────────────────
// `engines.vscode` is only a coarse version gate. Real compatibility depends on
// whether the contribution points + activation events an extension declares are
// actually backed by the Shogo extension host. These sets are the source of
// truth for that — keep them in sync with the host runner / host manager and
// docs/SUPPORTED_VSCODE_APIS.md.

/** Contribution points the host wires to real runtime behavior. */
export const SUPPORTED_CONTRIBUTION_POINTS: ReadonlySet<string> = new Set([
  'commands', 'menus', 'keybindings', 'views', 'viewsContainers', 'viewsWelcome', 'configuration',
])

/**
 * Contribution points that are parsed and consumed passively by the editor
 * (e.g. Monaco language/theme assets) rather than the extension host. Declaring
 * them does not by itself make an extension incompatible.
 */
export const PASSIVE_CONTRIBUTION_POINTS: ReadonlySet<string> = new Set([
  'languages', 'grammars', 'snippets', 'themes', 'iconThemes', 'productIconThemes', 'jsonValidation',
])

/** Contribution points recognized in the schema but NOT yet implemented. */
export const UNIMPLEMENTED_CONTRIBUTION_POINTS: ReadonlySet<string> = new Set([
  'debuggers', 'breakpoints', 'taskDefinitions', 'terminal', 'walkthroughs',
])

/** Activation-event prefixes the host can actually fire. */
export const SUPPORTED_ACTIVATION_EVENTS: readonly string[] = [
  '*', 'onStartupFinished', 'onCommand:', 'onView:', 'workspaceContains:', 'onLanguage:',
]

function isSupportedActivationEvent(event: string): boolean {
  return SUPPORTED_ACTIVATION_EVENTS.some((p) => (p.endsWith(':') ? event.startsWith(p) : event === p))
}

export interface ShogoCommandContribution {
  command: string
  title: string
  category?: string
  icon?: string | { light?: string; dark?: string }
}

export interface ShogoMenuContribution {
  command: string
  when?: string
  group?: string
  alt?: string
}

export interface ShogoViewContribution {
  id: string
  name: string
  when?: string
  icon?: string
  context?: string
}

export interface ShogoViewContainerContribution {
  id: string
  title: string
  icon?: string
}

export interface ShogoContributionPoints {
  commands?: ShogoCommandContribution[]
  menus?: Record<string, ShogoMenuContribution[]>
  keybindings?: Array<Record<string, unknown>>
  views?: Record<string, ShogoViewContribution[]>
  viewsContainers?: { activitybar?: ShogoViewContainerContribution[]; panel?: ShogoViewContainerContribution[] }
  viewsWelcome?: Array<Record<string, unknown>>
  configuration?: Record<string, unknown> | Record<string, unknown>[]
  languages?: Array<Record<string, unknown>>
  grammars?: Array<Record<string, unknown>>
  snippets?: Array<Record<string, unknown>>
  themes?: Array<Record<string, unknown>>
  iconThemes?: Array<Record<string, unknown>>
  productIconThemes?: Array<Record<string, unknown>>
  jsonValidation?: Array<Record<string, unknown>>
  debuggers?: Array<Record<string, unknown>>
  breakpoints?: Array<Record<string, unknown>>
  taskDefinitions?: Array<Record<string, unknown>>
  terminal?: Record<string, unknown>
  walkthroughs?: Array<Record<string, unknown>>
}

export interface ShogoExtensionManifest {
  id: string
  publisher: string
  name: string
  version: string
  displayName?: string
  description?: string
  categories?: string[]
  icon?: string
  engines: { vscode: string }
  main?: string
  browser?: string
  activationEvents?: string[]
  contributes?: ShogoContributionPoints
  extensionKind?: Array<'ui' | 'workspace'>
  extensionPack?: string[]
  extensionDependencies?: string[]
  capabilities?: {
    untrustedWorkspaces?: boolean | { supported: boolean | 'limited'; description?: string; restrictedConfigurations?: string[] }
    virtualWorkspaces?: boolean | { supported: boolean | 'limited'; description?: string }
  }
}

export interface ManifestParseResult {
  manifest: ShogoExtensionManifest
  warnings: string[]
  compatible: boolean
  compatibilityReason?: string
  /** Declared contribution points the host does not implement. */
  unsupportedContributions: string[]
  /** Declared activation events the host cannot fire. */
  unsupportedActivationEvents: string[]
}

const SUPPORTED_TOP_LEVEL = new Set([
  'name', 'displayName', 'description', 'version', 'publisher', 'engines', 'categories', 'icon',
  'main', 'browser', 'activationEvents', 'contributes', 'extensionKind', 'extensionPack',
  'extensionDependencies', 'capabilities', 'repository', 'license', 'homepage', 'bugs', 'keywords',
  'preview', 'badges', 'galleryBanner', 'qna', 'markdown', 'scripts', 'dependencies', 'devDependencies',
])

export function parseExtensionManifestJson(jsonText: string): ManifestParseResult {
  const parsed = JSON.parse(stripJsonComments(jsonText)) as Record<string, unknown>
  return normalizeExtensionManifest(parsed)
}

export function normalizeExtensionManifest(raw: Record<string, unknown>): ManifestParseResult {
  const warnings: string[] = []
  for (const key of Object.keys(raw)) {
    if (!SUPPORTED_TOP_LEVEL.has(key)) warnings.push(`Unsupported manifest field: ${key}`)
  }

  const name = requireString(raw.name, 'name')
  const publisher = requireString(raw.publisher, 'publisher')
  const version = requireString(raw.version, 'version')
  const engines = asRecord(raw.engines)
  if (!engines) throw new Error('Missing required manifest field: engines')
  const vscodeEngine = requireString(engines.vscode, 'engines.vscode')
  if (!isValidExtensionName(name)) throw new Error('Manifest field "name" must contain only letters, numbers, dots, underscores, or hyphens')
  if (!isValidExtensionName(publisher)) throw new Error('Manifest field "publisher" must contain only letters, numbers, dots, underscores, or hyphens')
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid extension version: ${version}`)

  const manifest: ShogoExtensionManifest = {
    id: `${publisher}.${name}`.toLowerCase(),
    publisher,
    name,
    version,
    engines: { vscode: vscodeEngine },
  }

  assignOptionalString(raw, manifest, 'displayName')
  assignOptionalString(raw, manifest, 'description')
  assignOptionalString(raw, manifest, 'icon')
  assignOptionalString(raw, manifest, 'main')
  assignOptionalString(raw, manifest, 'browser')
  manifest.categories = asStringArray(raw.categories, 'categories')
  manifest.activationEvents = asStringArray(raw.activationEvents, 'activationEvents')
  manifest.extensionPack = asStringArray(raw.extensionPack, 'extensionPack')
  manifest.extensionDependencies = asStringArray(raw.extensionDependencies, 'extensionDependencies')
  manifest.extensionKind = normalizeExtensionKind(raw.extensionKind)
  manifest.capabilities = normalizeCapabilities(raw.capabilities)
  manifest.contributes = normalizeContributes(raw.contributes, warnings)

  validateManifestPaths(manifest)

  const compatibility = computeCompatibility(vscodeEngine, manifest)
  for (const w of compatibility.warnings) warnings.push(w)
  return {
    manifest,
    warnings: [...new Set(warnings)],
    compatible: compatibility.compatible,
    compatibilityReason: compatibility.reason,
    unsupportedContributions: compatibility.unsupportedContributions,
    unsupportedActivationEvents: compatibility.unsupportedActivationEvents,
  }
}

export function stripJsonComments(input: string): string {
  let out = ''
  let inString = false
  let quote = ''
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    const next = input[i + 1]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        inString = false
        quote = ''
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < input.length && input[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) {
        out += input[i] === '\n' ? '\n' : ' '
        i++
      }
      i++
      continue
    }
    out += ch
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Missing required manifest field: ${field}`)
  return value
}

function assignOptionalString(raw: Record<string, unknown>, target: ShogoExtensionManifest, key: 'displayName' | 'description' | 'icon' | 'main' | 'browser'): void {
  const value = raw[key]
  if (typeof value === 'string' && value.length > 0) target[key] = value
  else if (value !== undefined) throw new Error(`Manifest field "${key}" must be a string`)
}

function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`Manifest field "${field}" must be an array of strings`)
  return value as string[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function normalizeExtensionKind(value: unknown): Array<'ui' | 'workspace'> | undefined {
  if (value === undefined) return undefined
  const values = Array.isArray(value) ? value : [value]
  const kinds: Array<'ui' | 'workspace'> = []
  for (const item of values) {
    if (item === 'ui' || item === 'workspace') kinds.push(item)
    else throw new Error('Manifest field "extensionKind" may only contain "ui" or "workspace"')
  }
  return kinds
}

function normalizeCapabilities(value: unknown): ShogoExtensionManifest['capabilities'] | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value)
  if (!record) throw new Error('Manifest field "capabilities" must be an object')
  return record as ShogoExtensionManifest['capabilities']
}

function normalizeContributes(value: unknown, warnings: string[]): ShogoContributionPoints | undefined {
  if (value === undefined) return undefined
  const record = asRecord(value)
  if (!record) throw new Error('Manifest field "contributes" must be an object')
  const supported = new Set([
    'commands', 'menus', 'keybindings', 'views', 'viewsContainers', 'viewsWelcome', 'configuration',
    'languages', 'grammars', 'snippets', 'themes', 'iconThemes', 'productIconThemes', 'jsonValidation',
    'debuggers', 'breakpoints', 'taskDefinitions', 'terminal', 'walkthroughs',
  ])
  for (const key of Object.keys(record)) {
    if (!supported.has(key)) warnings.push(`Unsupported contribution point: ${key}`)
  }
  return record as ShogoContributionPoints
}

function validateManifestPaths(manifest: ShogoExtensionManifest): void {
  for (const [field, value] of Object.entries(collectPathFields(manifest))) {
    if (!value) continue
    for (const p of value) validateRelativePath(p, field)
  }
}

function collectPathFields(manifest: ShogoExtensionManifest): Record<string, string[]> {
  const fields: Record<string, string[]> = {}
  const add = (field: string, value: unknown) => {
    if (typeof value === 'string') fields[field] = [...(fields[field] ?? []), value]
  }
  add('icon', manifest.icon)
  add('main', manifest.main)
  add('browser', manifest.browser)
  for (const command of manifest.contributes?.commands ?? []) {
    if (typeof command.icon === 'string') add('contributes.commands.icon', command.icon)
    else if (command.icon && typeof command.icon === 'object') {
      add('contributes.commands.icon.light', command.icon.light)
      add('contributes.commands.icon.dark', command.icon.dark)
    }
  }
  for (const container of manifest.contributes?.viewsContainers?.activitybar ?? []) add('contributes.viewsContainers.activitybar.icon', container.icon)
  for (const container of manifest.contributes?.viewsContainers?.panel ?? []) add('contributes.viewsContainers.panel.icon', container.icon)
  for (const views of Object.values(manifest.contributes?.views ?? {})) {
    for (const view of views) add('contributes.views.icon', view.icon)
  }
  for (const bucket of ['grammars', 'snippets', 'themes', 'iconThemes', 'productIconThemes', 'jsonValidation'] as const) {
    const entries = manifest.contributes?.[bucket]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (entry && typeof entry === 'object') {
        add(`contributes.${bucket}.path`, (entry as Record<string, unknown>).path)
      }
    }
  }
  return fields
}

export function validateRelativePath(input: string, field = 'path'): void {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) throw new Error(`Manifest field "${field}" must not use a URI scheme`)
  if (path.isAbsolute(input)) throw new Error(`Manifest field "${field}" must be relative`)
  const normalized = path.posix.normalize(input.replace(/\\/g, '/'))
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(`Manifest field "${field}" must not escape the extension directory`)
  if (normalized.includes('/../')) throw new Error(`Manifest field "${field}" must not contain path traversal`)
}

interface CompatibilityResult {
  compatible: boolean
  reason?: string
  warnings: string[]
  unsupportedContributions: string[]
  unsupportedActivationEvents: string[]
}

/**
 * Decide compatibility from BOTH the engine version gate AND the explicit
 * supported-API surface, so `compatible` reflects whether the extension can
 * actually function rather than just a semver claim.
 *
 * - Version too new → incompatible (unchanged contract).
 * - Otherwise: collect the declared contribution points / activation events the
 *   host cannot back. An extension is only marked incompatible when it would be
 *   non-functional: it has an executable `main` whose declared activation events
 *   are ALL unfireable, or it declares contributions that are ALL unimplemented.
 *   Partial gaps are reported as warnings, not a hard incompatibility.
 */
function computeCompatibility(engine: string, manifest: ShogoExtensionManifest): CompatibilityResult {
  const declaredContribs = Object.keys(manifest.contributes ?? {})
  const unsupportedContributions = declaredContribs.filter(
    (k) => !SUPPORTED_CONTRIBUTION_POINTS.has(k) && !PASSIVE_CONTRIBUTION_POINTS.has(k),
  )
  const activationEvents = manifest.activationEvents ?? []
  const unsupportedActivationEvents = activationEvents.filter((e) => !isSupportedActivationEvent(e))

  const warnings: string[] = []
  for (const c of unsupportedContributions) {
    warnings.push(`Contribution point "${c}" is declared but not implemented by the Shogo extension host`)
  }
  for (const e of unsupportedActivationEvents) {
    warnings.push(`Activation event "${e}" cannot be fired by the Shogo extension host`)
  }

  const base = { warnings, unsupportedContributions, unsupportedActivationEvents }

  const versionMatch = engine.match(/(\d+)\.(\d+)\.(\d+)|(\d+)\.(\d+)/)
  if (!versionMatch) {
    return { ...base, compatible: true, reason: 'Unable to parse engines.vscode; treated as compatible with warnings' }
  }
  const major = Number(versionMatch[1] ?? versionMatch[4])
  const minor = Number(versionMatch[2] ?? versionMatch[5])
  const [supportedMajor, supportedMinor] = SHOGO_VSCODE_COMPATIBILITY.split('.').map(Number)
  if (major > supportedMajor || (major === supportedMajor && minor > supportedMinor)) {
    return { ...base, compatible: false, reason: `Requires VS Code ${engine}; Shogo currently supports the ${SHOGO_VSCODE_COMPATIBILITY} API subset` }
  }

  // Non-functional cases: an activatable extension that can never activate, or
  // one whose only contributions are unimplemented.
  if (manifest.main && activationEvents.length > 0 && unsupportedActivationEvents.length === activationEvents.length) {
    return { ...base, compatible: false, reason: `None of the declared activation events are supported (${activationEvents.join(', ')})` }
  }
  if (declaredContribs.length > 0 && declaredContribs.every((k) => UNIMPLEMENTED_CONTRIBUTION_POINTS.has(k))) {
    return { ...base, compatible: false, reason: `Only unimplemented contribution points are declared (${declaredContribs.join(', ')})` }
  }

  const reason = (unsupportedContributions.length || unsupportedActivationEvents.length)
    ? 'Compatible with limitations — see warnings for unsupported features'
    : undefined
  return { ...base, compatible: true, reason }
}

function isValidExtensionName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}
