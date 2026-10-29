#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
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

const extensionPackage = readJson('apps/shogo-ide/extensions/shogo-core/package.json')
const tsconfig = readJson('apps/shogo-ide/extensions/shogo-core/tsconfig.json')
const extension = read('apps/shogo-ide/extensions/shogo-core/src/extension.ts')
const chatView = read('apps/shogo-ide/extensions/shogo-core/src/chatViewProvider.ts')
const commands = read('apps/shogo-ide/extensions/shogo-core/src/commands.ts')
const agentClient = read('apps/shogo-ide/extensions/shogo-core/src/agentClient.ts')
const contextOutbox = read('apps/shogo-ide/extensions/shogo-core/src/contextOutbox.ts')
const types = read('apps/shogo-ide/extensions/shogo-core/src/types.ts')
const web = read('apps/shogo-ide/extensions/shogo-core/src/web.ts')

read('apps/shogo-ide/extensions/shogo-core/src/vscode.d.ts')

if (extensionPackage) {
  assert(extensionPackage.scripts?.build === 'tsc -p tsconfig.json', 'shogo-core must expose build script')
  assert(extensionPackage.scripts?.typecheck === 'tsc --noEmit -p tsconfig.json', 'shogo-core must expose typecheck script')
  assert(extensionPackage.main === './dist/extension.js', 'shogo-core main must point to dist/extension.js')
  assert(extensionPackage.browser === './dist/web.js', 'shogo-core browser must point to dist/web.js')
  const commands = extensionPackage.contributes?.commands?.map((item) => item.command) ?? []
  for (const command of [
    'shogo.chat.focus',
    'shogo.health.check',
    'shogo.context.addSelection',
    'shogo.context.addActiveFile',
    'shogo.context.addExplorerItems',
    'shogo.context.addUris',
    'shogo.context.clear',
    'shogo.patch.preview',
    'shogo.checkpoint.create',
    'shogo.git.reviewChanges',
    'shogo.runtime.openPreview',
  ]) {
    assert(commands.includes(command), `manifest must contribute ${command}`)
  }
  assert(extensionPackage.scripts?.test === 'bun test', 'shogo-core must expose its unit tests')
  const menus = extensionPackage.contributes?.menus ?? {}
  assert(
    menus['explorer/context']?.some((item) => item.command === 'shogo.context.addExplorerItems'),
    'Explorer context menu must offer "Shogo: Add to Chat"',
  )
  assert(
    menus['editor/context']?.some((item) => item.command === 'shogo.context.addSelection'),
    'editor context menu must offer "Shogo: Add to Chat"',
  )
  const keybinding = extensionPackage.contributes?.keybindings?.find((item) => item.command === 'shogo.context.addSelection')
  assert(
    keybinding?.key === 'ctrl+l' && keybinding?.mac === 'cmd+l' && keybinding?.when === 'editorTextFocus',
    'Add to Chat must be bound to Ctrl+L / Cmd+L in the editor',
  )
  assert(
    menus.commandPalette?.some((item) => item.command === 'shogo.context.addUris' && item.when === 'false'),
    'shogo.context.addUris (Explorer drop target) must be hidden from the command palette',
  )
}

if (tsconfig) {
  assert(tsconfig.compilerOptions?.outDir === 'dist', 'extension tsconfig must emit to dist')
  assert(tsconfig.compilerOptions?.strict === true, 'extension tsconfig must keep strict mode')
}

assert(!extension.includes("registerWebviewViewProvider('shogo.chat'"), 'extension activation must not register the removed left-side chat webview provider')
assert(!extension.includes('registerTreeViews(context)'), 'extension activation must not register removed left-side Shogo tree views')
assert(extension.includes('registerCommands(context, services'), 'extension activation must register commands')
assert(extensionPackage?.contributes?.viewsContainers?.secondarySidebar?.some((container) => container.id === 'shogo-agent-chat'), 'shogo-core must contribute the Shogo Chat secondary sidebar container')
assert(extensionPackage?.contributes?.views?.['shogo-agent-chat']?.some((view) => view.id === 'shogo.agentChat'), 'shogo-core must contribute the Shogo Chat webview')
assert(chatView.includes('Content-Security-Policy'), 'chat webview must include CSP')
assert(chatView.includes('nonce-'), 'chat webview must use script nonce')
assert(chatView.includes('<iframe'), 'chat webview must embed the Desktop chat route')
assert(chatView.includes('SHOGO_DESKTOP_CHAT_URL'), 'chat webview must read the Desktop chat URL')
assert(chatView.includes('https://*.vscode-cdn.net'), 'chat webview CSP must allow Code-OSS webview CDN frames')
assert(commands.includes('requireTrustedWorkspace'), 'commands must guard workspace-trust-sensitive actions')
assert(commands.includes('shogo.context.addActiveFile'), 'commands must support active file context')
assert(agentClient.includes('/health'), 'agent client must support health endpoint')
assert(agentClient.includes('/chat'), 'agent client must support chat endpoint')
assert(agentClient.includes('local agent bridge is not connected'), 'agent client must have no-agent fallback')
assert(contextOutbox.includes('MAX_CONTEXT_TEXT_LENGTH'), 'context store must truncate context')
assert(contextOutbox.includes('class ShogoContextOutbox'), 'context must be delivered through the acknowledged outbox')
assert(chatView.includes("'shogo.ide.addReferences'") && chatView.includes("'shogo.ide.referencesAck'"), 'chat relay must forward Add to Chat references and their acks')
assert(!chatView.includes('storedContext'), 'IDE context must not carry storedContext (references go to the composer)')
read('apps/shogo-ide/extensions/shogo-core/src/references.ts')
assert(types.includes('ShogoContextItem'), 'types must define context item contract')
assert(web.includes("export { activate, deactivate } from './extension'"), 'web entrypoint must re-export activation')
assert(extension.includes("registerWebviewViewProvider('shogo.agentChat'"), 'shogo-core must register the Shogo webview provider')
assert(!extension.includes('createChatParticipant'), 'shogo-core must not register proposed native chat participants')

if (errors.length > 0) {
  console.error('Phase 3 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 3 check passed.')
console.log('Shogo Core extension shell is modular, buildable, and wired for chat/context/agent status.')
