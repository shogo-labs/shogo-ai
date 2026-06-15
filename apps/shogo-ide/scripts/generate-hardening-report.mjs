#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const workspaceRoot = resolve(new URL('..', import.meta.url).pathname)
const generatedDir = join(workspaceRoot, 'hardening', 'generated')

function readJson(relativePath) {
  const path = join(workspaceRoot, relativePath)
  if (!existsSync(path)) throw new Error(`Missing ${relativePath}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(relativePath, value) {
  const path = join(workspaceRoot, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

const product = readJson('distribution/generated/product.json')
const distribution = readJson('distribution/generated/distribution.generated.json')
const releaseChannels = readJson('hardening/release-channels.json')
const securityPolicy = readJson('hardening/security-policy.json')
const packagingChecklist = readJson('hardening/packaging-checklist.json')
const extensionPackage = readJson('extensions/shogo-core/package.json')

const requiredSourceFiles = [
  'product.shogo.template.json',
  'distribution/distribution.manifest.json',
  'distribution/defaults/settings.json',
  'distribution/defaults/layout.json',
  'distribution/builtin-extensions/shogo-core.json',
  'extensions/shogo-core/package.json',
  'extensions/shogo-core/src/extension.ts',
  'extensions/shogo-core/src/chatViewProvider.ts',
  'extensions/shogo-core/src/commands.ts',
]

const requiredGeneratedFiles = [
  'distribution/generated/product.json',
  'distribution/generated/distribution.generated.json',
]

const findings = []

if (product.enableTelemetry !== false) findings.push('Product telemetry is not disabled.')
if (!product.extensionsGallery?.serviceUrl?.includes('open-vsx.org')) findings.push('Open VSX gallery is not configured.')
if (product.urlProtocol !== 'shogo-ide') findings.push('Unexpected URL protocol.')
if (product.dataFolderName !== '.shogo-ide') findings.push('Data folder can collide with existing desktop app.')
if (extensionPackage.contributes?.configurationDefaults?.['shogo.security.requireApprovalForCommands'] !== true) findings.push('Command approval does not default to true.')
if (securityPolicy.telemetry?.default !== 'off') findings.push('Security policy telemetry default is not off.')
if (securityPolicy.marketplace?.microsoftMarketplaceEnabled !== false) findings.push('Microsoft Marketplace must remain disabled by default.')
if (!packagingChecklist.platforms?.darwin?.notarizationRequired) findings.push('macOS notarization is not marked required.')

for (const file of requiredSourceFiles) {
  if (!existsSync(join(workspaceRoot, file))) findings.push(`Missing source file: ${file}`)
}
for (const file of requiredGeneratedFiles) {
  if (!existsSync(join(workspaceRoot, file))) findings.push(`Missing generated file: ${file}`)
}

const report = {
  generatedAt: new Date().toISOString(),
  phase: 6,
  ok: findings.length === 0,
  product: {
    name: product.nameLong,
    applicationName: product.applicationName,
    protocol: product.urlProtocol,
    dataFolder: product.dataFolderName,
    extensionGallery: product.extensionsGallery?.serviceUrl,
    telemetryEnabled: product.enableTelemetry === true,
  },
  bundledExtension: {
    id: `${extensionPackage.publisher}.${extensionPackage.name}`,
    version: extensionPackage.version,
    main: extensionPackage.main,
    browser: extensionPackage.browser,
    activityContainer: distribution.extension?.activityContainer,
  },
  releaseChannels,
  securityPolicy,
  packagingChecklist,
  requiredSourceFiles,
  requiredGeneratedFiles,
  findings,
  nextManualGates: [
    'Code OSS checkout/package smoke test',
    'macOS signing and notarization',
    'Windows signing smoke test',
    'Linux desktop-file/AppImage smoke test',
    'Open VSX extension compatibility matrix',
    'large repository startup test',
    'rollback artifact test',
  ],
}

writeJson('hardening/generated/production-readiness.json', report)
console.log(`Generated ${join(generatedDir, 'production-readiness.json')}`)
if (!report.ok) {
  console.error('Production readiness findings:')
  for (const finding of findings) console.error(`  - ${finding}`)
  process.exit(1)
}
console.log('Production readiness report is clean for Phase 6 pre-package gates.')
