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
const tsconfig = readJson('apps/shogo-ide/extensions/shogo-core/tsconfig.json')
const extension = read('apps/shogo-ide/extensions/shogo-core/src/extension.ts')
const chatView = read('apps/shogo-ide/extensions/shogo-core/src/chatViewProvider.ts')
const commands = read('apps/shogo-ide/extensions/shogo-core/src/commands.ts')
const agentClient = read('apps/shogo-ide/extensions/shogo-core/src/agentClient.ts')
const contextStore = read('apps/shogo-ide/extensions/shogo-core/src/contextStore.ts')
const treeViews = read('apps/shogo-ide/extensions/shogo-core/src/treeViews.ts')
const types = read('apps/shogo-ide/extensions/shogo-core/src/types.ts')
const web = read('apps/shogo-ide/extensions/shogo-core/src/web.ts')
const docs = read('apps/shogo-ide/PHASE_3_SHOGO_CORE_EXTENSION.md')

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
    'shogo.context.clear',
    'shogo.patch.preview',
    'shogo.checkpoint.create',
    'shogo.git.reviewChanges',
    'shogo.runtime.openPreview',
  ]) {
    assert(commands.includes(command), `manifest must contribute ${command}`)
  }
}

if (tsconfig) {
  assert(tsconfig.compilerOptions?.outDir === 'dist', 'extension tsconfig must emit to dist')
  assert(tsconfig.compilerOptions?.strict === true, 'extension tsconfig must keep strict mode')
}

assert(extension.includes('registerWebviewViewProvider'), 'extension activation must register chat webview provider')
assert(extension.includes('registerTreeViews(context)'), 'extension activation must register tree views')
assert(extension.includes('registerCommands(context, chatView, services)'), 'extension activation must register commands')
assert(chatView.includes('Content-Security-Policy'), 'chat webview must include CSP')
assert(chatView.includes('nonce-'), 'chat webview must use script nonce')
assert(chatView.includes('sendPrompt'), 'chat webview must support prompt messages')
assert(commands.includes('requireTrustedWorkspace'), 'commands must guard workspace-trust-sensitive actions')
assert(commands.includes('shogo.context.addActiveFile'), 'commands must support active file context')
assert(agentClient.includes('/health'), 'agent client must support health endpoint')
assert(agentClient.includes('/chat'), 'agent client must support chat endpoint')
assert(agentClient.includes('Phase 3 Shogo Core extension shell'), 'agent client must have no-agent fallback')
assert(contextStore.includes('MAX_CONTEXT_TEXT_LENGTH'), 'context store must truncate context')
assert(treeViews.includes("registerTreeDataProvider('shogo.tasks'"), 'tree views must register tasks provider')
assert(types.includes('ShogoContextItem'), 'types must define context item contract')
assert(web.includes("export { activate, deactivate } from './extension'"), 'web entrypoint must re-export activation')
assert(docs.includes('Phase 3 still does not execute shell commands'), 'Phase 3 docs must state non-execution safety')

if (errors.length > 0) {
  console.error('Phase 3 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 3 check passed.')
console.log('Shogo Core extension shell is modular, buildable, and wired for chat/context/agent status.')
