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

function assert(condition, message) {
  if (!condition) errors.push(message)
}

const extension = read('apps/shogo-ide/extensions/shogo-core/src/extension.ts')
const chatView = read('apps/shogo-ide/extensions/shogo-core/src/chatViewProvider.ts')
const manifest = read('apps/shogo-ide/extensions/shogo-core/package.json')
const desktopBridge = read('apps/desktop/src/shogo-ide.ts')
const ideViews = read('apps/desktop/src/ide-views.ts')

assert(extension.includes("registerWebviewViewProvider('shogo.agentChat'"), 'shogo-core must register the Shogo Chat webview')
assert(chatView.includes('workbench.view.extension.shogo-agent-chat'), 'shogo-core must focus the Shogo Chat auxiliary container')
assert(chatView.includes('SHOGO_DESKTOP_CHAT_URL'), 'chat webview must receive the Desktop chat URL')
assert(chatView.includes('<iframe'), 'chat webview must embed Desktop chat instead of duplicating chat logic')
assert(chatView.includes('addSelection'), 'chat webview must keep selection context handoff')
assert(chatView.includes('openExternal'), 'chat webview must expose a Desktop fallback action')
assert(chatView.includes('https://*.vscode-cdn.net'), 'chat webview must allow Code-OSS webview CDN frames')
assert(manifest.includes('shogo.desktopChat.url'), 'extension manifest must expose the Desktop chat URL setting')
assert(manifest.includes('shogo-agent-chat'), 'extension manifest must own the Shogo Chat secondary sidebar container')
assert(manifest.includes('shogo.agentChat'), 'extension manifest must own the Shogo Chat webview')
assert(!desktopBridge.includes('extensions/shogo-agent-chat'), 'desktop bridge must not require the removed standalone chat extension')
assert(desktopBridge.includes('syncBundledShogoExtensions'), 'desktop bridge must sync bundled Shogo extensions into the runtime profile')
assert(desktopBridge.includes('syncFilteredSystemExtensions'), 'desktop bridge must filter upstream system extensions')
assert(ideViews.includes('SHOGO_DESKTOP_CHAT_URL'), 'managed workbench must pass the Desktop chat URL to Code-OSS')
assert(ideViews.includes('--builtin-extensions-dir'), 'managed workbench must use the filtered system extensions directory')

if (errors.length > 0) {
  console.error('Shogo Agent Chat Phase 5/6 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Shogo Agent Chat Phase 5/6 check passed.')
console.log('Standalone chat logic has been replaced by shogo-core Desktop chat embedding and filtered runtime wiring.')
