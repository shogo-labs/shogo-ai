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

const extension = read('apps/shogo-ide/extensions/shogo-agent-chat/src/extension.ts')
const manifest = readJson('apps/shogo-ide/extensions/shogo-agent-chat/package.json')
const settings = readJson('apps/shogo-ide/distribution/defaults/settings.json')
const layout = readJson('apps/shogo-ide/distribution/defaults/layout.json')
const materializer = read('apps/shogo-ide/scripts/materialize-distribution.mjs')

assert(manifest?.displayName === 'Shogo Chat', 'extension display name must be native Shogo Chat')
assert(manifest?.version === '0.0.0-phase.8', 'extension manifest must report Phase 8')
assert(manifest?.contributes?.commands?.some((command) => command.command === 'shogo.agentChat.focusInput'), 'manifest must contribute focus input command')
assert(manifest?.contributes?.commands?.some((command) => command.command === 'shogo.agentChat.explainSelection'), 'manifest must contribute explain selection command')
assert(manifest?.contributes?.commands?.some((command) => command.command === 'shogo.agentChat.fixSelection'), 'manifest must contribute fix selection command')
assert(Array.isArray(manifest?.contributes?.keybindings) && manifest.contributes.keybindings.length >= 3, 'manifest must contribute native keybindings')
assert(!manifest?.contributes?.chatParticipants, 'manifest must not use proposed native chat participant APIs')
assert(manifest?.contributes?.views?.['workbench.panel.chat']?.some((view) => view.id === 'shogo.agentChat'), 'manifest must contribute Shogo Chat as a right-side Chat panel webview')
assert(manifest?.contributes?.menus?.['editor/context']?.some((item) => item.command === 'shogo.agentChat.explainSelection'), 'editor context menu must expose Shogo selection actions')

assert(extension.includes('createStatusBarItem'), 'extension must create a Shogo status bar item')
assert(extension.includes('shogo.agentChat.focusInput'), 'extension must register a focus input command')
assert(extension.includes('openShogoChatOnStartup'), 'extension must own startup auto-open behavior')
assert(extension.includes('ensureShogoChatInRightPanel'), 'extension must move stale Shogo Chat views back to the right Chat panel')
assert(extension.includes("destinationId: 'workbench.panel.chat'"), 'extension must target the right Chat panel when correcting view placement')
assert(!manifest?.contributes?.viewsContainers?.activitybar?.some((container) => container.id === 'shogo-agent-chat'), 'manifest must not contribute a left Activity Bar Shogo Chat container')
assert(extension.includes("registerWebviewViewProvider('shogo.agentChat'"), 'extension must register the Shogo right-panel webview provider')
assert(extension.includes('shogo.agentChat.focus'), 'extension must focus the Shogo right-panel webview')
assert(!extension.includes('createChatParticipant'), 'extension must not register proposed native chat participants')
assert(!extension.includes('workbench.view.extension.shogo-agent-chat'), 'extension must not open the old left Activity Bar container')
assert(extension.includes('prefillPrompt'), 'extension must support native prefill actions')
assert(extension.includes('focusComposer'), 'webview must support native composer focus')
assert(extension.includes('pendingComposerText'), 'extension must preserve pending native composer text')
assert(extension.includes('nativePhase: 8'), 'webview state must report native Phase 8')

assert(settings?.['shogo.agentChat.autoOpen'] === true, 'default settings must auto-open Shogo Chat')
assert(settings?.['workbench.secondarySideBar.defaultVisibility'] === 'visible', 'secondary side bar must be visible by default')
assert(settings?.['github.copilot.chat.enabled'] === false, 'Copilot Chat must remain disabled')
assert(settings?.['chat.disableAIFeatures'] === true, 'upstream native AI chat must remain disabled so GitHub sign-in is not shown')
assert(settings?.['chat.restoreLastPanelSession'] === false, 'built-in chat restore must remain disabled')
assert(layout?.activityBar?.defaultContainer === 'workbench.view.explorer', 'default activity bar container must be Explorer, not Shogo')
assert(!layout?.activityBar?.visibleContainers?.includes('shogo'), 'layout must not show a Shogo Activity Bar icon')
assert(!layout?.activityBar?.visibleContainers?.includes('shogo-agent-chat'), 'layout must not show a separate Shogo Chat Activity Bar icon')
assert(layout?.chat?.defaultContainer === 'workbench.panel.chat', 'default chat container must be the right-side Chat panel')
assert(layout?.chat?.autoOpenView === 'shogo.agentChat', 'layout must auto-open the Shogo right-side Chat panel webview')
assert(layout?.views?.['workbench.panel.chat']?.includes('shogo.agentChat'), 'layout must include Shogo Chat in the right-side Chat panel')
assert(!layout?.views?.shogo?.length, 'layout must not include any left-side Shogo views')
assert(materializer.includes('phase: 8'), 'generated distribution metadata must materialize Phase 8')

if (errors.length > 0) {
  console.error('Shogo Agent Chat Phase 7/8 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Shogo Agent Chat Phase 7/8 check passed.')
console.log('Native UX polish and Shogo-first auto-open behavior are wired.')
