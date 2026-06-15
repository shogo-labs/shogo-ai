#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const workspaceRoot = resolve(new URL('..', import.meta.url).pathname)
const generatedDir = join(workspaceRoot, 'distribution', 'generated')
const productTemplatePath = join(workspaceRoot, 'product.shogo.template.json')
const extensionPackagePath = join(workspaceRoot, 'extensions', 'shogo-core', 'package.json')
const defaultsSettingsPath = join(workspaceRoot, 'distribution', 'defaults', 'settings.json')
const defaultsLayoutPath = join(workspaceRoot, 'distribution', 'defaults', 'layout.json')
const builtinDescriptorPath = join(workspaceRoot, 'distribution', 'builtin-extensions', 'shogo-core.json')
const distributionManifestPath = join(workspaceRoot, 'distribution', 'distribution.manifest.json')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`)
}

function assertFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${relative(workspaceRoot, path)}`)
  }
}

assertFile(productTemplatePath, 'product template')
assertFile(extensionPackagePath, 'shogo-core package')
assertFile(defaultsSettingsPath, 'default settings')
assertFile(defaultsLayoutPath, 'default layout')
assertFile(builtinDescriptorPath, 'built-in extension descriptor')
assertFile(distributionManifestPath, 'distribution manifest')

const product = readJson(productTemplatePath)
const extensionPackage = readJson(extensionPackagePath)
const settings = readJson(defaultsSettingsPath)
const layout = readJson(defaultsLayoutPath)
const builtinDescriptor = readJson(builtinDescriptorPath)
const distributionManifest = readJson(distributionManifestPath)

const productJson = {
  ...product,
  builtInExtensions: [
    {
      name: extensionPackage.name,
      version: extensionPackage.version,
      repo: 'https://github.com/shogo-labs/shogo-ai',
      metadata: {
        id: `${extensionPackage.publisher}.${extensionPackage.name}`,
        publisherId: extensionPackage.publisher,
        publisherDisplayName: 'Shogo Labs',
      },
    },
  ],
  shogoDistribution: {
    phase: 4,
    defaultSettingsPath: 'distribution/defaults/settings.json',
    defaultLayoutPath: 'distribution/defaults/layout.json',
    builtinExtensionDescriptors: ['distribution/builtin-extensions/shogo-core.json'],
    currentDesktopFallback: true,
  },
}

const generatedManifest = {
  generatedAt: new Date().toISOString(),
  phase: 4,
  product: {
    nameShort: productJson.nameShort,
    nameLong: productJson.nameLong,
    applicationName: productJson.applicationName,
    dataFolderName: productJson.dataFolderName,
    urlProtocol: productJson.urlProtocol,
    extensionGallery: productJson.extensionsGallery?.serviceUrl ?? null,
    telemetryEnabled: productJson.enableTelemetry === true,
  },
  extension: {
    id: `${extensionPackage.publisher}.${extensionPackage.name}`,
    version: extensionPackage.version,
    main: extensionPackage.main,
    browser: extensionPackage.browser,
    activityContainer: extensionPackage.contributes?.viewsContainers?.activitybar?.[0]?.id ?? null,
    views: extensionPackage.contributes?.views?.shogo?.map((view) => view.id) ?? [],
    walkthroughs: extensionPackage.contributes?.walkthroughs?.map((walkthrough) => walkthrough.id) ?? [],
  },
  defaults: {
    settings,
    layout,
  },
  builtinExtensions: [builtinDescriptor],
  sourceManifest: distributionManifest,
}

writeJson(join(generatedDir, 'product.json'), productJson)
writeJson(join(generatedDir, 'distribution.generated.json'), generatedManifest)

console.log('Materialized Shogo IDE distribution metadata:')
console.log(`  ${relative(process.cwd(), join(generatedDir, 'product.json'))}`)
console.log(`  ${relative(process.cwd(), join(generatedDir, 'distribution.generated.json'))}`)
