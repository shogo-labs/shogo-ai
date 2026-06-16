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
assert(manifest?.contributes?.menus?.['view/title']?.some((item) => item.command === 'shogo.agentChat.newChat'), 'view title must expose Shogo actions')
assert(manifest?.contributes?.menus?.['editor/context']?.some((item) => item.command === 'shogo.agentChat.explainSelection'), 'editor context menu must expose Shogo selection actions')

assert(extension.includes('createStatusBarItem'), 'extension must create a Shogo status bar item')
assert(extension.includes('shogo.agentChat.focusInput'), 'extension must register a focus input command')
assert(extension.includes('openShogoChatOnStartup'), 'extension must own startup auto-open behavior')
assert(manifest?.contributes?.viewsContainers?.activitybar?.some((container) => container.id === 'shogo-agent-chat'), 'manifest must contribute a supported Shogo Chat activity bar container')
assert(extension.includes('workbench.view.extension.shogo-agent-chat'), 'extension must open the Shogo activity container')
assert(extension.includes('prefillPrompt'), 'extension must support native prefill actions')
assert(extension.includes('focusComposer'), 'webview must support native composer focus')
assert(extension.includes('pendingComposerText'), 'extension must preserve pending native composer text')
assert(extension.includes('nativePhase: 8'), 'webview state must report native Phase 8')

assert(settings?.['shogo.agentChat.autoOpen'] === true, 'default settings must auto-open Shogo Chat')
assert(settings?.['workbench.secondarySideBar.defaultVisibility'] === 'visible', 'secondary side bar must be visible by default')
assert(settings?.['github.copilot.chat.enabled'] === false, 'Copilot Chat must remain disabled')
assert(settings?.['chat.restoreLastPanelSession'] === false, 'built-in chat restore must remain disabled')
assert(layout?.activityBar?.defaultContainer === 'shogo-agent-chat', 'default activity bar container must be Shogo Chat')
assert(layout?.activityBar?.autoOpenView === 'shogo.agentChat', 'layout must auto-open the Shogo Chat view')
assert(materializer.includes('phase: 8'), 'generated distribution metadata must materialize Phase 8')

if (errors.length > 0) {
  console.error('Shogo Agent Chat Phase 7/8 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Shogo Agent Chat Phase 7/8 check passed.')
console.log('Native UX polish and Shogo-first auto-open behavior are wired.')
