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

const extensionPackage = readJson('apps/shogo-ide/extensions/shogo-core/package.json')
const agentChatPackage = readJson('apps/shogo-ide/extensions/shogo-agent-chat/package.json')
const tsconfig = readJson('apps/shogo-ide/extensions/shogo-core/tsconfig.json')
const extension = read('apps/shogo-ide/extensions/shogo-core/src/extension.ts')
const chatView = read('apps/shogo-ide/extensions/shogo-core/src/chatViewProvider.ts')
const commands = read('apps/shogo-ide/extensions/shogo-core/src/commands.ts')
const agentClient = read('apps/shogo-ide/extensions/shogo-core/src/agentClient.ts')
const contextStore = read('apps/shogo-ide/extensions/shogo-core/src/contextStore.ts')
const treeViews = read('apps/shogo-ide/extensions/shogo-core/src/treeViews.ts')
const types = read('apps/shogo-ide/extensions/shogo-core/src/types.ts')
const web = read('apps/shogo-ide/extensions/shogo-core/src/web.ts')
const agentChatExtension = read('apps/shogo-ide/extensions/shogo-agent-chat/src/extension.ts')
const agentChatReadme = read('apps/shogo-ide/extensions/shogo-agent-chat/README.md')
const docs = read('apps/shogo-ide/PHASE_3_SHOGO_CORE_EXTENSION.md')

read('apps/shogo-ide/extensions/shogo-core/src/vscode.d.ts')
read('apps/shogo-ide/extensions/shogo-agent-chat/src/vscode.d.ts')

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
    'shogo.context.clear',
    'shogo.patch.preview',
    'shogo.checkpoint.create',
    'shogo.git.reviewChanges',
    'shogo.runtime.openPreview',
  ]) {
    assert(commands.includes(command), `manifest must contribute ${command}`)
  }
}

if (agentChatPackage) {
  assert(/^0\.0\.0-phase\.(8|9|10)$/.test(agentChatPackage.version || ''), 'shogo-agent-chat version must track the current Shogo chat phase')
  assert(agentChatPackage.contributes?.viewsContainers?.auxiliarybar?.some((container) => container.id === 'shogo-agent-chat'), 'shogo-agent-chat must contribute the Shogo auxiliary container')
  assert(agentChatPackage.contributes?.views?.['shogo-agent-chat']?.some((view) => view.id === 'shogo.agentChat'), 'shogo-agent-chat must contribute the Shogo webview to its auxiliary container')
  assert(!agentChatPackage.contributes?.chatParticipants, 'shogo-agent-chat must not use proposed native chat participant APIs')
  assert(agentChatPackage.contributes?.configurationDefaults?.['shogo.agentChat.autoOpen'] === true, 'shogo-agent-chat must auto-open by default')
}

if (tsconfig) {
  assert(tsconfig.compilerOptions?.outDir === 'dist', 'extension tsconfig must emit to dist')
  assert(tsconfig.compilerOptions?.strict === true, 'extension tsconfig must keep strict mode')
}

assert(!extension.includes("registerWebviewViewProvider('shogo.chat'"), 'extension activation must not register the removed left-side chat webview provider')
assert(!extension.includes('registerTreeViews(context)'), 'extension activation must not register removed left-side Shogo tree views')
assert(extension.includes('registerCommands(context, services)'), 'extension activation must register commands')
assert(chatView.includes('Content-Security-Policy'), 'chat webview must include CSP')
assert(chatView.includes('nonce-'), 'chat webview must use script nonce')
assert(chatView.includes('sendPrompt'), 'chat webview must support prompt messages')
assert(commands.includes('requireTrustedWorkspace'), 'commands must guard workspace-trust-sensitive actions')
assert(commands.includes('shogo.context.addActiveFile'), 'commands must support active file context')
assert(agentClient.includes('/health'), 'agent client must support health endpoint')
assert(agentClient.includes('/chat'), 'agent client must support chat endpoint')
assert(agentClient.includes('Phase 3 Shogo Core extension shell'), 'agent client must have no-agent fallback')
assert(contextStore.includes('MAX_CONTEXT_TEXT_LENGTH'), 'context store must truncate context')
assert(treeViews.includes("registerTreeDataProvider('shogo.tasks'"), 'tree view helpers may remain available but must not be activated by default')
assert(types.includes('ShogoContextItem'), 'types must define context item contract')
assert(web.includes("export { activate, deactivate } from './extension'"), 'web entrypoint must re-export activation')
assert(agentChatExtension.includes('data-shogo-desktop-chat-ui="true"'), 'agent chat webview must mark the reused Desktop chat UI shell')
assert(agentChatExtension.includes('desktop-chat-shell'), 'agent chat webview must use Desktop chat shell layout class')
assert(agentChatExtension.includes('composer-card'), 'agent chat webview must use Desktop-style composer card')
assert(agentChatExtension.includes('context-chip'), 'agent chat webview must render Desktop-style context chips')
assert(agentChatExtension.includes('Ask Shogo to fix, explain, refactor, or review this code'), 'agent chat composer must use the Desktop-style Shogo prompt placeholder')
assert(agentChatExtension.includes("registerWebviewViewProvider('shogo.agentChat'"), 'agent chat extension must register the Shogo webview provider')
assert(!agentChatExtension.includes('createChatParticipant'), 'agent chat extension must not register proposed native chat participants')
assert(agentChatExtension.includes('<select id="model"'), 'agent chat webview must expose model/mode control in the composer')
assert(agentChatReadme.includes('reuses the Shogo Desktop chat UI shell'), 'agent chat README must document Desktop chat UI reuse')
assert(docs.includes('Phase 3 still does not execute shell commands'), 'Phase 3 docs must state non-execution safety')

if (errors.length > 0) {
  console.error('Phase 3 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 3 check passed.')
console.log('Shogo Core extension shell is modular, buildable, and wired for chat/context/agent status.')
