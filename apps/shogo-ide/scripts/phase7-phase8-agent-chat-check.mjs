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

const extension = read('apps/shogo-ide/extensions/shogo-core/src/extension.ts')
const chatView = read('apps/shogo-ide/extensions/shogo-core/src/chatViewProvider.ts')
const manifest = readJson('apps/shogo-ide/extensions/shogo-core/package.json')
const settings = readJson('apps/shogo-ide/distribution/defaults/settings.json')
const layout = readJson('apps/shogo-ide/distribution/defaults/layout.json')
const materializer = read('apps/shogo-ide/scripts/materialize-distribution.mjs')

assert(manifest?.displayName === 'Shogo', 'extension display name must be Shogo')
assert(!manifest?.contributes?.chatParticipants, 'manifest must not use proposed native chat participant APIs')
assert(manifest?.contributes?.viewsContainers?.secondarySidebar?.some((container) => container.id === 'shogo-agent-chat'), 'manifest must contribute Shogo Chat as a secondary sidebar container')
assert(manifest?.contributes?.views?.['shogo-agent-chat']?.some((view) => view.id === 'shogo.agentChat'), 'manifest must contribute Shogo Chat webview in its secondary sidebar container')
assert(!manifest?.contributes?.viewsContainers?.activitybar?.some((container) => container.id === 'shogo-agent-chat'), 'manifest must not contribute a left Activity Bar Shogo Chat container')

assert(extension.includes("registerWebviewViewProvider('shogo.agentChat'"), 'extension must register the Shogo webview provider')
assert(manifest?.contributes?.commands?.some((command) => command.command === 'shogo.chat.focus'), 'extension must expose the Shogo chat focus command')
assert(chatView.includes('workbench.view.extension.shogo-agent-chat'), 'extension must focus the Shogo Chat auxiliary container')
assert(!extension.includes('createChatParticipant'), 'extension must not register proposed native chat participants')
assert(!extension.includes('workbench.panel.chat'), 'extension must not target a missing upstream Chat panel container')

assert(chatView.includes('SHOGO_DESKTOP_CHAT_URL'), 'webview must read the Desktop chat URL from the launcher')
assert(chatView.includes('desktopChat.url') && manifest?.contributes?.configuration?.properties?.['shogo.desktopChat.url'], 'webview must support configured Desktop chat URL fallback')
assert(chatView.includes('<iframe'), 'webview must embed the Desktop chat route')
assert(chatView.includes('openExternal'), 'webview must offer an external-open fallback')
assert(chatView.includes('addSelection'), 'webview must preserve selection-to-context action')
assert(chatView.includes('https://*.vscode-cdn.net'), 'webview CSP must allow Code-OSS webview CDN frames')
assert(chatView.includes('http://localhost:*') && chatView.includes('http://127.0.0.1:*'), 'webview CSP must allow local Desktop chat frames')

assert(settings?.['workbench.secondarySideBar.defaultVisibility'] === 'visible', 'secondary side bar must be visible by default')
assert(settings?.['workbench.secondarySideBar.showLabels'] === true, 'secondary side bar labels must be visible by default')
assert(settings?.['github.copilot.chat.enabled'] === false, 'Copilot Chat must remain disabled')
assert(settings?.['chat.disableAIFeatures'] === true, 'upstream native AI chat must remain disabled so GitHub sign-in is not shown')
assert(settings?.['chat.restoreLastPanelSession'] === false, 'built-in chat restore must remain disabled')
assert(settings?.['shogo.agentChat.autoOpen'] === undefined, 'removed shogo-agent-chat auto-open setting must not remain in defaults')
assert(layout?.activityBar?.defaultContainer === 'workbench.view.explorer', 'default activity bar container must be Explorer, not Shogo')
assert(!layout?.activityBar?.visibleContainers?.includes('shogo'), 'layout must not show a Shogo Activity Bar icon')
assert(!layout?.activityBar?.visibleContainers?.includes('shogo-agent-chat'), 'layout must not show a separate Shogo Chat Activity Bar icon')
assert(layout?.chat?.defaultContainer === 'shogo-agent-chat', 'default chat container must be the Shogo auxiliary container')
assert(layout?.chat?.autoOpenView === 'shogo.agentChat', 'layout must auto-open the Shogo Chat webview')
assert(layout?.views?.['shogo-agent-chat']?.includes('shogo.agentChat'), 'layout must include Shogo Chat in the auxiliary container')
assert(!layout?.views?.shogo?.length, 'layout must not include any left-side Shogo views')
assert(/phase: (8|9|10)/.test(materializer), 'generated distribution metadata must materialize Phase 8 or later')

if (errors.length > 0) {
  console.error('Shogo Agent Chat Phase 7/8 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Shogo Agent Chat Phase 7/8 check passed.')
console.log('Shogo Chat is owned by shogo-core and embedded from Desktop with hardened CSP/runtime wiring.')
