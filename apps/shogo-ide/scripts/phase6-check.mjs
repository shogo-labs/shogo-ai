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

const releaseChannels = readJson('apps/shogo-ide/hardening/release-channels.json')
const securityPolicy = readJson('apps/shogo-ide/hardening/security-policy.json')
const packagingChecklist = readJson('apps/shogo-ide/hardening/packaging-checklist.json')
const readiness = readJson('apps/shogo-ide/hardening/generated/production-readiness.json')
const desktopBridge = read('apps/desktop/src/shogo-ide.ts')
const replacementGate = read('apps/mobile/components/project/panels/ide/ShogoIdeReplacementGate.tsx')
const docs = read('apps/shogo-ide/PHASE_6_PRODUCTION_HARDENING.md')
const packageJson = readJson('apps/shogo-ide/package.json')
const rootPackage = readJson('package.json')

if (releaseChannels) {
  assert(releaseChannels.phase === 6, 'release channels must be Phase 6')
  assert(releaseChannels.channels?.insiders?.minimumChecks?.includes('phase6:check'), 'insiders channel must require phase6:check')
  assert(releaseChannels.channels?.stable?.minimumChecks?.includes('rollback artifact available'), 'stable channel must require rollback artifact')
  assert(releaseChannels.rollback?.required === true, 'rollback must be required')
}

if (securityPolicy) {
  assert(securityPolicy.workspaceTrust?.requiredFor?.includes('shell commands'), 'security policy must gate shell commands on workspace trust')
  assert(securityPolicy.commandApproval?.defaultRequired === true, 'command approval must default to required')
  assert(securityPolicy.marketplace?.defaultGallery === 'Open VSX', 'security policy must use Open VSX')
  assert(securityPolicy.marketplace?.microsoftMarketplaceEnabled === false, 'Microsoft Marketplace must be disabled by default')
  assert(securityPolicy.telemetry?.default === 'off', 'telemetry must default off')
  assert(securityPolicy.webview?.strictCspRequired === true, 'webviews must require strict CSP')
}

if (packagingChecklist) {
  assert(packagingChecklist.platforms?.darwin?.signingRequired === true, 'macOS signing must be required')
  assert(packagingChecklist.platforms?.darwin?.notarizationRequired === true, 'macOS notarization must be required')
  assert(packagingChecklist.platforms?.win32?.signingRequired === true, 'Windows signing must be required')
  assert(packagingChecklist.preflight?.includes('verify telemetry defaults are off'), 'preflight must verify telemetry defaults')
  assert(packagingChecklist.postInstallSmoke?.includes('Shogo activity view visible'), 'post-install smoke must verify Shogo activity view')
}

if (readiness) {
  assert(readiness.phase === 6, 'readiness report must be Phase 6')
  assert(readiness.ok === true, 'readiness report must be clean')
  assert(readiness.product?.telemetryEnabled === false, 'readiness report must show telemetry disabled')
  assert(readiness.nextManualGates?.includes('macOS signing and notarization'), 'readiness report must list manual signing gate')
}

assert(desktopBridge.includes('hardeningReportPath'), 'desktop bridge must include hardening report status')
assert(desktopBridge.includes('generatedProductPath'), 'desktop bridge must include generated product status')
assert(desktopBridge.includes('executableExecutable'), 'desktop bridge must validate executable permissions')
assert(desktopBridge.includes('writeLaunchDiagnostic'), 'desktop bridge must write launch diagnostics')
assert(desktopBridge.includes('phase: 6'), 'desktop bridge status must report Phase 6')

assert(replacementGate.includes('diagnostics?: string[]'), 'replacement gate must accept diagnostics')
assert(replacementGate.includes('diagnostics.map'), 'replacement gate must render diagnostics')
assert(replacementGate.includes('hardeningReportExists'), 'replacement gate must understand hardening report status')

assert(docs.toLowerCase().includes('production hardening'), 'Phase 6 docs must describe production hardening')
assert(docs.includes('No commit or push'), 'Phase 6 docs must preserve no-commit/no-push posture')
assert(docs.includes('Manual gates remain'), 'Phase 6 docs must document remaining manual gates')

if (packageJson) {
  assert(packageJson.scripts?.['phase6:check'], 'apps/shogo-ide must expose phase6:check')
  assert(packageJson.scripts?.['hardening:report'], 'apps/shogo-ide must expose hardening:report')
}

if (rootPackage) {
  assert(rootPackage.scripts?.['shogo-ide:phase6:check'], 'root package must expose shogo-ide:phase6:check')
  assert(rootPackage.scripts?.['shogo-ide:hardening:report'], 'root package must expose shogo-ide:hardening:report')
}

if (errors.length > 0) {
  console.error('Phase 6 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 6 check passed.')
console.log('Production hardening manifests, diagnostics, release gates, and launcher checks are wired.')
