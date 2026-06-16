#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const workspaceRoot = resolve(new URL('..', import.meta.url).pathname)
const generatedDir = join(workspaceRoot, 'distribution', 'generated')
const productTemplatePath = join(workspaceRoot, 'product.shogo.template.json')
const defaultsSettingsPath = join(workspaceRoot, 'distribution', 'defaults', 'settings.json')
const defaultsLayoutPath = join(workspaceRoot, 'distribution', 'defaults', 'layout.json')
const builtinDescriptorsDir = join(workspaceRoot, 'distribution', 'builtin-extensions')
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

function readBuiltInDescriptors() {
  assertFile(builtinDescriptorsDir, 'built-in extension descriptors directory')
  return readdirSync(builtinDescriptorsDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const descriptorPath = join(builtinDescriptorsDir, file)
      const descriptor = readJson(descriptorPath)
      const packagePath = join(workspaceRoot, 'extensions', descriptor.name, 'package.json')
      assertFile(packagePath, `${descriptor.name} package`)
      return {
        descriptorPath,
        descriptor,
        packageJson: readJson(packagePath),
      }
    })
}

assertFile(productTemplatePath, 'product template')
assertFile(defaultsSettingsPath, 'default settings')
assertFile(defaultsLayoutPath, 'default layout')
assertFile(distributionManifestPath, 'distribution manifest')

const product = readJson(productTemplatePath)
const settings = readJson(defaultsSettingsPath)
const layout = readJson(defaultsLayoutPath)
const builtIns = readBuiltInDescriptors()
const distributionManifest = readJson(distributionManifestPath)

const productJson = {
  ...product,
  builtInExtensions: builtIns.map(({ packageJson }) => ({
    name: packageJson.name,
    version: packageJson.version,
    repo: 'https://github.com/shogo-labs/shogo-ai',
    metadata: {
      id: `${packageJson.publisher}.${packageJson.name}`,
      publisherId: packageJson.publisher,
      publisherDisplayName: 'Shogo Labs',
    },
  })),
  shogoDistribution: {
    phase: 8,
    defaultSettingsPath: 'distribution/defaults/settings.json',
    defaultLayoutPath: 'distribution/defaults/layout.json',
    builtinExtensionDescriptors: builtIns.map(({ descriptorPath }) => relative(workspaceRoot, descriptorPath)),
    currentDesktopFallback: true,
  },
}

const generatedManifest = {
  generatedAt: new Date().toISOString(),
  phase: 8,
  product: {
    nameShort: productJson.nameShort,
    nameLong: productJson.nameLong,
    applicationName: productJson.applicationName,
    dataFolderName: productJson.dataFolderName,
    urlProtocol: productJson.urlProtocol,
    extensionGallery: productJson.extensionsGallery?.serviceUrl ?? null,
    telemetryEnabled: productJson.enableTelemetry === true,
  },
  extensions: builtIns.map(({ descriptor, packageJson }) => ({
    id: `${packageJson.publisher}.${packageJson.name}`,
    version: packageJson.version,
    main: packageJson.main,
    browser: packageJson.browser,
    activityContainer: packageJson.contributes?.viewsContainers?.activitybar?.[0]?.id ?? null,
    auxiliaryContainer: packageJson.contributes?.viewsContainers?.auxiliarybar?.[0]?.id ?? null,
    chatContainer: packageJson.contributes?.views?.['workbench.panel.chat'] ? 'workbench.panel.chat' : null,
    views: Object.values(packageJson.contributes?.views ?? {}).flat().map((view) => view.id),
    walkthroughs: packageJson.contributes?.walkthroughs?.map((walkthrough) => walkthrough.id) ?? [],
    descriptor,
  })),
  extension: null,
  defaults: {
    settings,
    layout,
  },
  builtinExtensions: builtIns.map(({ descriptor }) => descriptor),
  sourceManifest: distributionManifest,
}

generatedManifest.extension = generatedManifest.extensions.find((extension) => extension.id === 'shogo.shogo-core') ?? generatedManifest.extensions[0] ?? null

writeJson(join(generatedDir, 'product.json'), productJson)
writeJson(join(generatedDir, 'distribution.generated.json'), generatedManifest)

console.log('Materialized Shogo IDE distribution metadata:')
console.log(`  ${relative(process.cwd(), join(generatedDir, 'product.json'))}`)
console.log(`  ${relative(process.cwd(), join(generatedDir, 'distribution.generated.json'))}`)
