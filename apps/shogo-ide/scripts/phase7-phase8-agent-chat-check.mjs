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

function renderedWebviewScript(source) {
  const startMarker = '    return `<!doctype html>'
  const start = source.indexOf(startMarker)
  if (start < 0) {
    errors.push('webview render template is missing')
    return ''
  }
  const bodyStart = start + '    return `'.length
  const end = source.indexOf('`\n  }\n}', bodyStart)
  if (end < 0) {
    errors.push('webview render template is not closed as expected')
    return ''
  }
  try {
    const templateBody = source.slice(bodyStart, end)
    const html = Function('scriptNonce', 'csp', `return \`${templateBody}\``)('phase-check', "default-src 'none'; script-src 'nonce-phase-check'")
    const scriptStartMarker = '  <script nonce="phase-check">'
    const scriptStart = html.indexOf(scriptStartMarker)
    const scriptEnd = html.indexOf('  </script>', scriptStart)
    if (scriptStart < 0 || scriptEnd < 0) {
      errors.push('rendered webview script tag is missing')
      return ''
    }
    return html.slice(scriptStart + scriptStartMarker.length, scriptEnd)
  } catch (error) {
    errors.push(`rendered webview template failed to evaluate: ${error.message}`)
    return ''
  }
}

const extension = read('apps/shogo-ide/extensions/shogo-agent-chat/src/extension.ts')
const webviewScript = renderedWebviewScript(extension)
if (webviewScript) {
  try {
    Function(webviewScript)
  } catch (error) {
    errors.push(`rendered webview script must be valid JavaScript: ${error.message}`)
  }
  assert(webviewScript.includes('before.match(/(^|\\s)\\/([\\w-]*)$/)'), 'rendered slash command regex must preserve whitespace, slash, and word escapes')
  assert(webviewScript.includes('before.match(/(^|\\s)([#@])([\\w./:-]*)$/)'), 'rendered context mention regex must preserve whitespace and word escapes')
  assert(webviewScript.includes('replace(/^\\s*/,'), 'rendered slash command cleanup must trim whitespace')
  assert(webviewScript.includes('replace(/\\n+$/,'), 'rendered Enter fallback must trim inserted newlines')
  assert(!webviewScript.includes('before.match(/(^|s)/([w-]*)$/)'), 'rendered slash command regex must not lose escapes')
  assert(!webviewScript.includes('replace(/^s*/,'), 'rendered slash command cleanup must not lose whitespace escape')
}
const manifest = readJson('apps/shogo-ide/extensions/shogo-agent-chat/package.json')
const settings = readJson('apps/shogo-ide/distribution/defaults/settings.json')
const layout = readJson('apps/shogo-ide/distribution/defaults/layout.json')
const materializer = read('apps/shogo-ide/scripts/materialize-distribution.mjs')

assert(manifest?.displayName === 'Shogo Chat', 'extension display name must be native Shogo Chat')
assert(/^0\.0\.0-phase\.(8|9|10)$/.test(manifest?.version || ''), 'extension manifest must report Phase 8 or later')
assert(manifest?.contributes?.commands?.some((command) => command.command === 'shogo.agentChat.focusInput'), 'manifest must contribute focus input command')
assert(manifest?.contributes?.commands?.some((command) => command.command === 'shogo.agentChat.explainSelection'), 'manifest must contribute explain selection command')
assert(manifest?.contributes?.commands?.some((command) => command.command === 'shogo.agentChat.fixSelection'), 'manifest must contribute fix selection command')
assert(Array.isArray(manifest?.contributes?.keybindings) && manifest.contributes.keybindings.length >= 3, 'manifest must contribute native keybindings')
assert(!manifest?.contributes?.chatParticipants, 'manifest must not use proposed native chat participant APIs')
assert(manifest?.contributes?.viewsContainers?.auxiliarybar?.some((container) => container.id === 'shogo-agent-chat'), 'manifest must contribute Shogo Chat as an auxiliary bar container')
assert(manifest?.contributes?.views?.['shogo-agent-chat']?.some((view) => view.id === 'shogo.agentChat'), 'manifest must contribute Shogo Chat in its auxiliary container')
assert(manifest?.contributes?.menus?.['editor/context']?.some((item) => item.command === 'shogo.agentChat.explainSelection'), 'editor context menu must expose Shogo selection actions')

assert(extension.includes('createStatusBarItem'), 'extension must create a Shogo status bar item')
assert(extension.includes('shogo.agentChat.focusInput'), 'extension must register a focus input command')
assert(extension.includes('openShogoChatOnStartup'), 'extension must own startup auto-open behavior')
assert(extension.includes('showShogoChatContainer'), 'extension must open the Shogo Chat auxiliary container')
assert(extension.includes('workbench.view.extension.shogo-agent-chat'), 'extension must focus the Shogo Chat auxiliary container')
assert(!manifest?.contributes?.viewsContainers?.activitybar?.some((container) => container.id === 'shogo-agent-chat'), 'manifest must not contribute a left Activity Bar Shogo Chat container')
assert(extension.includes("registerWebviewViewProvider('shogo.agentChat'"), 'extension must register the Shogo webview provider')
assert(extension.includes('shogo.agentChat.focus'), 'extension must focus the Shogo webview')
assert(!extension.includes('createChatParticipant'), 'extension must not register proposed native chat participants')
assert(!extension.includes('workbench.panel.chat'), 'extension must not target a missing upstream Chat panel container')
assert(extension.includes('prefillPrompt'), 'extension must support native prefill actions')
assert(extension.includes('focusComposer'), 'webview must support native composer focus')
assert(extension.includes('pendingComposerText'), 'extension must preserve pending native composer text')
assert(extension.includes("promptEl.addEventListener('beforeinput'") && extension.includes("event.inputType === 'insertLineBreak'"), 'webview must prevent raw Enter from inserting a newline before send')
assert(extension.includes("promptEl.addEventListener('input'") && extension.includes("promptEl.value.replace(/\\\\n+$/"), 'webview must fall back when Enter inserts a newline before handlers win')
assert(extension.includes("document.addEventListener('keydown'") && extension.includes('handlePromptEnter(event)'), 'webview must capture Enter-to-send reliably')
assert(extension.includes('allowNextLineBreak'), 'webview must preserve Shift+Enter newline behavior')
assert(extension.includes("msg.type === 'webviewError'") && extension.includes('reportWebviewError'), 'webview must report runtime errors visibly')
assert(/nativePhase: (8|9|10)/.test(extension), 'webview state must report native Phase 8 or later')

assert(settings?.['shogo.agentChat.autoOpen'] === true, 'default settings must auto-open Shogo Chat')
assert(settings?.['workbench.secondarySideBar.defaultVisibility'] === 'visible', 'secondary side bar must be visible by default')
assert(settings?.['github.copilot.chat.enabled'] === false, 'Copilot Chat must remain disabled')
assert(settings?.['chat.disableAIFeatures'] === true, 'upstream native AI chat must remain disabled so GitHub sign-in is not shown')
assert(settings?.['chat.restoreLastPanelSession'] === false, 'built-in chat restore must remain disabled')
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
console.log('Native UX polish and Shogo-first auto-open behavior are wired.')
