#!/usr/bin/env node
// Brand a Code - OSS checkout's product.json as Shogo IDE before it is built.
// Usage: node scripts/apply-product-overrides.mjs <code-oss checkout>

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const PRODUCT_OVERRIDE_KEYS = [
  'nameShort',
  'nameLong',
  'applicationName',
  'dataFolderName',
  'serverDataFolderName',
  'urlProtocol',
  'licenseName',
  'licenseUrl',
  'quality',
  'documentationUrl',
  'reportIssueUrl',
  'requestFeatureUrl',
  'privacyStatementUrl',
  'telemetryOptOutUrl',
  'extensionsGallery',
  'linkProtectionTrustedDomains',
  'enableTelemetry',
  'extensionEnabledApiProposals',
  'aiConfig',
]

const COPILOT_IDS = new Set(['GitHub.copilot', 'GitHub.copilot-chat'])

/**
 * Returns upstream's product.json with Shogo's identity applied. Marketplace
 * built-ins are dropped (shogo-core is copied into the build instead) so the
 * build never downloads Microsoft extensions.
 */
export function applyProductOverrides(product, generatedProduct) {
  const next = { ...product }
  for (const key of PRODUCT_OVERRIDE_KEYS) {
    if (generatedProduct[key] !== undefined) next[key] = generatedProduct[key]
  }
  next.builtInExtensions = []
  delete next.defaultChatAgent
  delete next.trustedExtensionAuthAccess
  next.builtInExtensionsEnabledWithAutoUpdates = Array.isArray(product.builtInExtensionsEnabledWithAutoUpdates)
    ? product.builtInExtensionsEnabledWithAutoUpdates.filter((id) => !COPILOT_IDS.has(id))
    : []
  return next
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const checkout = process.argv[2]
  if (!checkout) {
    console.error('Usage: node scripts/apply-product-overrides.mjs <code-oss checkout>')
    process.exit(1)
  }
  const productPath = join(resolve(checkout), 'product.json')
  const generated = JSON.parse(readFileSync(join(root, 'distribution', 'generated', 'product.json'), 'utf8'))
  const next = applyProductOverrides(JSON.parse(readFileSync(productPath, 'utf8')), generated)
  writeFileSync(productPath, `${JSON.stringify(next, null, '\t')}\n`)
  console.log(`Applied Shogo product overrides to ${productPath}`)
}
