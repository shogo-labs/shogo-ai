#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const errors = []
const warnings = []

function requireFile(relativePath) {
  const path = join(root, relativePath)
  if (!existsSync(path) || !statSync(path).isFile()) {
    errors.push(`Missing required file: ${relativePath}`)
    return null
  }
  return path
}

function readJson(relativePath) {
  const path = requireFile(relativePath)
  if (!path) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    errors.push(`Invalid JSON in ${relativePath}: ${error.message}`)
    return null
  }
}

function assert(condition, message) {
  if (!condition) errors.push(message)
}

function warn(condition, message) {
  if (!condition) warnings.push(message)
}

const packageJson = readJson('package.json')
const product = readJson('product.shogo.template.json')
const extension = readJson('extensions/shogo-core/package.json')

requireFile('README.md')
requireFile('PHASE_1_EDGE_CASES.md')
requireFile('.gitignore')
requireFile('extensions/shogo-core/README.md')
requireFile('extensions/shogo-core/src/extension.ts')
requireFile('extensions/shogo-core/media/shogo.svg')
requireFile('scripts/print-code-oss-clone-command.mjs')

if (packageJson) {
  assert(packageJson.name === '@shogo/shogo-ide', 'apps/shogo-ide package must be named @shogo/shogo-ide')
  assert(packageJson.private === true, 'apps/shogo-ide package must remain private during Phase 1')
  assert(packageJson.scripts?.['phase1:check'], 'apps/shogo-ide must expose phase1:check')
}

if (product) {
  assert(product.nameShort === 'Shogo', 'product nameShort must be Shogo')
  assert(product.nameLong === 'Shogo IDE', 'product nameLong must be Shogo IDE')
  assert(product.applicationName === 'shogo-ide', 'product applicationName must be shogo-ide')
  assert(product.dataFolderName === '.shogo-ide', 'product dataFolderName must not reuse current Shogo Desktop data folder')
  assert(product.urlProtocol === 'shogo-ide', 'product urlProtocol must avoid colliding with existing shogo:// desktop protocol in Phase 1')
  assert(product.extensionsGallery?.serviceUrl?.includes('open-vsx.org'), 'extension gallery must default to Open VSX')
  assert(product.enableTelemetry === false, 'Phase 1 product template must disable telemetry')
  assert(Array.isArray(product.builtInExtensions), 'product template must list built-in extensions')
  assert(product.builtInExtensions?.some((item) => item.name === 'shogo-core'), 'product template must include shogo-core as a built-in extension')
}

if (extension) {
  assert(extension.name === 'shogo-core', 'extension name must be shogo-core')
  assert(extension.publisher === 'shogo', 'extension publisher must be shogo')
  assert(extension.private === true, 'extension must remain private in Phase 1')
  assert(extension.capabilities?.untrustedWorkspaces?.supported === 'limited', 'extension must declare limited untrusted workspace support')
  assert(extension.capabilities?.virtualWorkspaces?.supported === 'limited', 'extension must declare limited virtual workspace support')
  assert(extension.contributes?.viewsContainers?.activitybar?.some((view) => view.id === 'shogo'), 'extension must contribute the Shogo activity bar container')
  assert(extension.contributes?.views?.shogo?.some((view) => view.id === 'shogo.chat'), 'extension must contribute shogo.chat view')
  assert(extension.contributes?.commands?.some((command) => command.command === 'shogo.health.check'), 'extension must contribute shogo.health.check command')
  assert(extension.contributes?.configuration?.properties?.['shogo.security.requireApprovalForCommands']?.default === true, 'command approval must default to true')
}

const gitignorePath = requireFile('.gitignore')
if (gitignorePath) {
  const gitignore = readFileSync(gitignorePath, 'utf8')
  assert(gitignore.includes('upstream/vscode/'), '.gitignore must ignore the local Code - OSS checkout')
}

const upstreamPath = join(root, 'upstream/vscode')
warn(!existsSync(upstreamPath), 'Local Code - OSS checkout exists. Make sure it remains untracked and is not accidentally committed.')

if (warnings.length > 0) {
  console.log('Phase 1 warnings:')
  for (const warning of warnings) console.log(`  - ${warning}`)
  console.log('')
}

if (errors.length > 0) {
  console.error('Phase 1 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 1 check passed.')
console.log('Shogo IDE spike files are present, isolated, and configured for the Code - OSS distribution path.')
