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

function assert(condition, message) {
  if (!condition) errors.push(message)
}

const extension = read('apps/shogo-ide/extensions/shogo-core/src/extension.ts')
const chatView = read('apps/shogo-ide/extensions/shogo-core/src/chatViewProvider.ts')
const manifest = read('apps/shogo-ide/extensions/shogo-core/package.json')
const desktopBridge = read('apps/desktop/src/shogo-ide.ts')
const ideViews = read('apps/desktop/src/ide-views.ts')
const serverBuild = read('apps/shogo-ide/scripts/build-code-oss-server.mjs')

assert(extension.includes("registerWebviewViewProvider('shogo.agentChat'"), 'shogo-core must register the Shogo Chat webview')
assert(chatView.includes('workbench.view.extension.shogo-agent-chat'), 'shogo-core must focus the Shogo Chat auxiliary container')
assert(chatView.includes('SHOGO_DESKTOP_CHAT_URL'), 'chat webview must receive the Desktop chat URL')
assert(chatView.includes('<iframe'), 'chat webview must embed Desktop chat instead of duplicating chat logic')
assert(chatView.includes('shogo.ide.addReferences'), 'chat webview must hand selection context to the chat composer')
assert(chatView.includes('openExternal'), 'chat webview must expose a Desktop fallback action')
assert(chatView.includes('https://*.vscode-cdn.net'), 'chat webview must allow Code-OSS webview CDN frames')
assert(manifest.includes('shogo.desktopChat.url'), 'extension manifest must expose the Desktop chat URL setting')
assert(manifest.includes('shogo-agent-chat'), 'extension manifest must own the Shogo Chat secondary sidebar container')
assert(manifest.includes('shogo.agentChat'), 'extension manifest must own the Shogo Chat webview')
assert(!desktopBridge.includes('extensions/shogo-agent-chat'), 'desktop bridge must not require the removed standalone chat extension')
// shogo-core is built into the prebuilt server and Copilot is removed from it at build time.
assert(serverBuild.includes("join(extensionsDir, 'shogo-core')"), 'the server build must bundle shogo-core as a built-in extension')
assert(serverBuild.includes("'copilot', 'copilot-chat'"), 'the server build must remove the upstream Copilot extensions')
assert(desktopBridge.includes("'shogo.desktopChat.url'"), 'runtime settings must carry the Desktop chat URL')
assert(ideViews.includes('SHOGO_DESKTOP_CHAT_URL'), 'managed workbench must pass the Desktop chat URL to Code-OSS')

if (errors.length > 0) {
  console.error('Shogo Agent Chat Phase 5/6 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Shogo Agent Chat Phase 5/6 check passed.')
console.log('Standalone chat logic has been replaced by shogo-core Desktop chat embedding and filtered runtime wiring.')
