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
const agentChatPackage = readJson('apps/shogo-ide/extensions/shogo-agent-chat/package.json')
const defaultSettings = readJson('apps/shogo-ide/distribution/defaults/settings.json')
const defaultLayout = readJson('apps/shogo-ide/distribution/defaults/layout.json')
const builtin = readJson('apps/shogo-ide/distribution/builtin-extensions/shogo-core.json')
const agentChatBuiltin = readJson('apps/shogo-ide/distribution/builtin-extensions/shogo-agent-chat.json')
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
  assert(product.aiConfig?.upstreamCopilotDisabled === true, 'product template must mark upstream Copilot disabled for Shogo IDE')
  assert(product.aiConfig?.disabledUpstreamExtensionIds?.includes('GitHub.copilot-chat'), 'product template must list upstream Copilot Chat as disabled')
}

if (extensionPackage) {
  const contributes = extensionPackage.contributes ?? {}
  assert(!contributes.viewsContainers?.activitybar?.some((container) => container.id === 'shogo'), 'extension must not contribute a left-side Shogo activity container')
  assert(!contributes.views?.shogo?.length, 'extension must not contribute Shogo views to the left sidebar')
  assert(contributes.walkthroughs?.some((walkthrough) => walkthrough.id === 'shogo.getStarted'), 'extension must provide Shogo getting-started walkthrough')
  assert(contributes.configurationDefaults?.['shogo.security.requireApprovalForCommands'] === true, 'extension defaults must require command approval')
  assert(contributes.configurationDefaults?.['github.copilot.chat.enabled'] === false, 'extension defaults must disable GitHub Copilot Chat')
  assert(contributes.configurationDefaults?.['chat.disableAIFeatures'] === true, 'extension defaults must disable upstream native AI chat so GitHub sign-in is not shown')
  assert(contributes.configurationDefaults?.['chat.titleBar.signIn.enabled'] === false, 'extension defaults must hide upstream chat sign-in affordances')
}

if (agentChatPackage) {
  const contributes = agentChatPackage.contributes ?? {}
  assert(agentChatPackage.name === 'shogo-agent-chat', 'agent chat extension name must be shogo-agent-chat')
  assert(agentChatPackage.main === './dist/extension.js', 'agent chat extension main must point to dist/extension.js')
  assert(!contributes.viewsContainers?.activitybar?.some((container) => container.id === 'shogo-agent-chat'), 'agent chat extension must not contribute a separate Shogo Chat activity bar container')
  assert(!contributes.chatParticipants, 'agent chat extension must not use proposed native chat participant APIs')
  assert(contributes.views?.['workbench.panel.chat']?.some((view) => view.id === 'shogo.agentChat'), 'agent chat extension must contribute Shogo Chat as a right-side Chat panel webview')
  assert(contributes.commands?.some((command) => command.command === 'shogo.agentChat.open'), 'agent chat extension must contribute open command')
  assert(contributes.configurationDefaults?.['github.copilot.chat.enabled'] === false, 'agent chat extension defaults must keep Copilot Chat disabled')
  assert(contributes.configurationDefaults?.['shogo.agentChat.autoOpen'] === true, 'agent chat extension defaults must auto-open Shogo chat')
}

if (defaultSettings) {
  assert(defaultSettings['telemetry.telemetryLevel'] === 'off', 'default settings must disable telemetry')
  assert(defaultSettings['security.workspace.trust.enabled'] === true, 'default settings must enable workspace trust')
  assert(defaultSettings['shogo.security.requireApprovalForCommands'] === true, 'default settings must require command approval')
  assert(defaultSettings['github.copilot.chat.enabled'] === false, 'default settings must disable GitHub Copilot Chat')
  assert(defaultSettings['chat.disableAIFeatures'] === true, 'default settings must disable upstream native AI chat so GitHub sign-in is not shown')
  assert(defaultSettings['chat.titleBar.signIn.enabled'] === false, 'default settings must hide upstream chat sign-in affordances')
  assert(defaultSettings['workbench.secondarySideBar.defaultVisibility'] === 'visible', 'default settings must show the auxiliary bar for Shogo Agent Chat')
  assert(defaultSettings['shogo.agentChat.autoOpen'] === true, 'default settings must auto-open Shogo Agent Chat')
}

if (defaultLayout) {
  assert(defaultLayout.activityBar?.defaultContainer === 'workbench.view.explorer', 'default layout should start with Explorer, not a Shogo activity container')
  assert(!defaultLayout.activityBar?.visibleContainers?.includes('shogo'), 'default layout must not show a Shogo Activity Bar icon')
  assert(!defaultLayout.activityBar?.visibleContainers?.includes('shogo-agent-chat'), 'default layout must not show a separate Shogo Chat Activity Bar icon')
  assert(defaultLayout.chat?.defaultContainer === 'workbench.panel.chat', 'default layout should use the right-side Chat container')
  assert(defaultLayout.chat?.autoOpenView === 'shogo.agentChat', 'default layout should auto-open the right-side Shogo chat webview')
  assert(defaultLayout.views?.['workbench.panel.chat']?.includes('shogo.agentChat'), 'default layout must include Shogo Chat in the right-side Chat panel')
  assert(!defaultLayout.views?.shogo?.length, 'default layout must not include any left-side Shogo views')
  assert(defaultLayout.fallback?.currentMonacoIdeRemainsAvailable === true, 'default layout must preserve Monaco fallback')
}

if (builtin) {
  assert(builtin.id === 'shogo.shogo-core', 'builtin descriptor must target shogo.shogo-core')
  assert(builtin.sourcePath === '../../extensions/shogo-core', 'builtin descriptor must point to shogo-core source')
  assert(builtin.bundle?.requiredFiles?.includes('dist/extension.js'), 'builtin descriptor must require built extension.js')
  assert(builtin.defaultVisibility?.activityContainer === null, 'builtin descriptor must not default a Shogo activity container visible')
  assert(builtin.defaultVisibility?.views?.length === 0, 'builtin descriptor must not default Shogo left-side views visible')
}

if (agentChatBuiltin) {
  assert(agentChatBuiltin.id === 'shogo.shogo-agent-chat', 'agent chat builtin descriptor must target shogo.shogo-agent-chat')
  assert(agentChatBuiltin.sourcePath === '../../extensions/shogo-agent-chat', 'agent chat builtin descriptor must point to shogo-agent-chat source')
  assert(agentChatBuiltin.bundle?.requiredFiles?.includes('dist/extension.js'), 'agent chat builtin descriptor must require built extension.js')
  assert(agentChatBuiltin.defaultVisibility?.chatContainer === 'workbench.panel.chat', 'agent chat builtin descriptor must default to the right-side Chat container')
  assert(agentChatBuiltin.defaultVisibility?.views?.includes('shogo.agentChat'), 'agent chat builtin descriptor must default to the Shogo right-panel webview')
}

if (manifest) {
  assert(manifest.phase >= 4, 'distribution manifest must be Phase 4 or later')
  assert(manifest.extensionGallery === 'Open VSX', 'distribution manifest must state Open VSX')
  assert(manifest.telemetryDefault === 'off', 'distribution manifest must state telemetry off')
  assert(manifest.coexistence?.currentMonacoIdeFallback === true, 'distribution manifest must preserve current Monaco fallback')
  assert(manifest.builtinExtensions?.includes('builtin-extensions/shogo-agent-chat.json'), 'distribution manifest must include shogo-agent-chat builtin descriptor')
}

if (generatedProduct) {
  assert(generatedProduct.shogoDistribution?.phase >= 4, 'generated product must include Phase 4-or-later Shogo distribution metadata')
  assert(generatedProduct.builtInExtensions?.some((extension) => extension.metadata?.id === 'shogo.shogo-core'), 'generated product must include shogo-core built-in metadata')
  assert(generatedProduct.builtInExtensions?.some((extension) => extension.metadata?.id === 'shogo.shogo-agent-chat'), 'generated product must include shogo-agent-chat built-in metadata')
  assert(generatedProduct.extensionsGallery?.serviceUrl?.includes('open-vsx.org'), 'generated product must preserve Open VSX')
  assert(generatedProduct.aiConfig?.upstreamCopilotDisabled === true, 'generated product must carry upstream Copilot disabled metadata')
}

if (generatedManifest) {
  assert(generatedManifest.phase >= 4, 'generated manifest must be Phase 4 or later')
  assert(generatedManifest.extension?.activityContainer === null, 'generated manifest must not discover a Shogo activity container')
  assert(generatedManifest.extension?.walkthroughs?.includes('shogo.getStarted'), 'generated manifest must discover getting-started walkthrough')
  assert((generatedManifest.extension?.views?.length ?? 0) === 0, 'generated manifest must not discover Shogo left-side views')
  assert(generatedManifest.extensions?.some((extension) => extension.id === 'shogo.shogo-agent-chat' && extension.activityContainer === null && extension.chatContainer === 'workbench.panel.chat' && extension.views?.includes('shogo.agentChat')), 'generated manifest must discover Shogo Agent Chat as the right-side webview')
  assert(!generatedManifest.extensions?.some((extension) => extension.chatParticipants?.includes('shogo.agent') || extension.defaultChatParticipant === 'shogo.agent'), 'generated manifest must not include proposed native chat participant metadata')
  assert(generatedManifest.defaults?.settings?.['telemetry.telemetryLevel'] === 'off', 'generated manifest must include telemetry-off defaults')
  assert(generatedManifest.defaults?.settings?.['github.copilot.chat.enabled'] === false, 'generated manifest must include Copilot Chat disabled defaults')
  assert(generatedManifest.defaults?.settings?.['chat.disableAIFeatures'] === true, 'generated manifest must disable upstream native AI chat so GitHub sign-in is not shown')
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
