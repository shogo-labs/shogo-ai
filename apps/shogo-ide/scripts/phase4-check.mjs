#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(new URL('../../..', import.meta.url).pathname)
const errors = []

function read(relativePath) {
  const path = join(root, relativePath)
  if (!existsSync(path)) {
    errors.push(`Missing required file: ${relativePath}`)
    return ''
  }
  return readFileSync(path, 'utf8')
}

function readJson(relativePath) {
  const text = read(relativePath)
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch (error) {
    errors.push(`Invalid JSON in ${relativePath}: ${error.message}`)
    return null
  }
}

function assert(condition, message) {
  if (!condition) errors.push(message)
}

const product = readJson('apps/shogo-ide/product.shogo.template.json')
const extensionPackage = readJson('apps/shogo-ide/extensions/shogo-core/package.json')
const defaultSettings = readJson('apps/shogo-ide/distribution/defaults/settings.json')
const defaultLayout = readJson('apps/shogo-ide/distribution/defaults/layout.json')
const builtin = readJson('apps/shogo-ide/distribution/builtin-extensions/shogo-core.json')
const manifest = readJson('apps/shogo-ide/distribution/distribution.manifest.json')
const generatedProduct = readJson('apps/shogo-ide/distribution/generated/product.json')
const generatedManifest = readJson('apps/shogo-ide/distribution/generated/distribution.generated.json')
const materializeScript = read('apps/shogo-ide/scripts/materialize-distribution.mjs')
const docs = read('apps/shogo-ide/PHASE_4_DISTRIBUTION_INTEGRATION.md')

if (product) {
  assert(product.nameLong === 'Shogo IDE', 'product template must identify Shogo IDE')
  assert(product.applicationName === 'shogo-ide', 'applicationName must be shogo-ide')
  assert(product.urlProtocol === 'shogo-ide', 'protocol must be shogo-ide in Phase 4')
  assert(product.dataFolderName === '.shogo-ide', 'data folder must avoid current desktop collision')
  assert(product.extensionsGallery?.serviceUrl?.includes('open-vsx.org'), 'product must use Open VSX gallery')
  assert(product.enableTelemetry === false, 'telemetry must be disabled in product template')
}

if (extensionPackage) {
  const contributes = extensionPackage.contributes ?? {}
  assert(contributes.viewsContainers?.activitybar?.some((container) => container.id === 'shogo'), 'extension must contribute Shogo activity container')
  assert(contributes.viewsWelcome?.some((welcome) => welcome.view === 'shogo.chat'), 'extension must provide Shogo chat welcome content')
  assert(contributes.walkthroughs?.some((walkthrough) => walkthrough.id === 'shogo.getStarted'), 'extension must provide Shogo getting-started walkthrough')
  assert(contributes.configurationDefaults?.['telemetry.telemetryLevel'] === 'off', 'extension defaults must disable telemetry')
  assert(contributes.configurationDefaults?.['shogo.security.requireApprovalForCommands'] === true, 'extension defaults must require command approval')
}

if (defaultSettings) {
  assert(defaultSettings['telemetry.telemetryLevel'] === 'off', 'default settings must disable telemetry')
  assert(defaultSettings['security.workspace.trust.enabled'] === true, 'default settings must enable workspace trust')
  assert(defaultSettings['shogo.security.requireApprovalForCommands'] === true, 'default settings must require command approval')
}

if (defaultLayout) {
  assert(defaultLayout.activityBar?.defaultContainer === 'shogo', 'default layout should start with Shogo activity container')
  assert(defaultLayout.fallback?.currentMonacoIdeRemainsAvailable === true, 'default layout must preserve Monaco fallback')
}

if (builtin) {
  assert(builtin.id === 'shogo.shogo-core', 'builtin descriptor must target shogo.shogo-core')
  assert(builtin.sourcePath === '../../extensions/shogo-core', 'builtin descriptor must point to shogo-core source')
  assert(builtin.bundle?.requiredFiles?.includes('dist/extension.js'), 'builtin descriptor must require built extension.js')
  assert(builtin.defaultVisibility?.activityContainer === 'shogo', 'builtin descriptor must default Shogo activity container visible')
}

if (manifest) {
  assert(manifest.phase === 4, 'distribution manifest must be Phase 4')
  assert(manifest.extensionGallery === 'Open VSX', 'distribution manifest must state Open VSX')
  assert(manifest.telemetryDefault === 'off', 'distribution manifest must state telemetry off')
  assert(manifest.coexistence?.currentMonacoIdeFallback === true, 'distribution manifest must preserve current Monaco fallback')
}

if (generatedProduct) {
  assert(generatedProduct.shogoDistribution?.phase === 4, 'generated product must include Phase 4 Shogo distribution metadata')
  assert(generatedProduct.builtInExtensions?.[0]?.metadata?.id === 'shogo.shogo-core', 'generated product must include shogo-core built-in metadata')
  assert(generatedProduct.extensionsGallery?.serviceUrl?.includes('open-vsx.org'), 'generated product must preserve Open VSX')
}

if (generatedManifest) {
  assert(generatedManifest.phase === 4, 'generated manifest must be Phase 4')
  assert(generatedManifest.extension?.activityContainer === 'shogo', 'generated manifest must discover Shogo activity container')
  assert(generatedManifest.extension?.walkthroughs?.includes('shogo.getStarted'), 'generated manifest must discover getting-started walkthrough')
  assert(generatedManifest.defaults?.settings?.['telemetry.telemetryLevel'] === 'off', 'generated manifest must include telemetry-off defaults')
}

assert(materializeScript.includes('Materialized Shogo IDE distribution metadata'), 'materialize script must produce explicit output')
assert(docs.includes('No Code - OSS source is vendored'), 'Phase 4 docs must state no upstream vendoring')
assert(docs.includes('Open VSX'), 'Phase 4 docs must document Open VSX posture')

if (errors.length > 0) {
  console.error('Phase 4 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 4 check passed.')
console.log('Shogo IDE distribution metadata, defaults, built-in extension mapping, and generated product files are coherent.')
