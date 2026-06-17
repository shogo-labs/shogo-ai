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

const extension = read('apps/shogo-ide/extensions/shogo-agent-chat/src/extension.ts')
const manifest = read('apps/shogo-ide/extensions/shogo-agent-chat/package.json')

assert(extension.includes('interface RichIdeContext'), 'extension must define a rich IDE context contract')
assert(extension.includes('collectRichIdeContext'), 'extension must collect rich IDE context')
assert(extension.includes('visibleEditors'), 'rich IDE context must include visible editors')
assert(extension.includes('diagnostics'), 'rich IDE context must include diagnostics')
assert(extension.includes('terminals'), 'rich IDE context must include terminal summaries')
assert(extension.includes('type ContextKind'), 'extension must define typed context attachment kinds')
assert(extension.includes('ContextSuggestion'), 'extension must define context mention suggestions')
assert(extension.includes('collectContextSuggestions'), 'extension must collect # mention context suggestions')
assert(extension.includes('openContextPicker'), 'extension must expose a context picker')
assert(extension.includes('requestContextSuggestions'), 'webview must request # mention autocomplete suggestions')
assert(extension.includes('addContextSuggestion'), 'webview must attach selected # mention suggestions')
assert(extension.includes('data-open-context-id'), 'context chips must be openable')
assert(extension.includes('data-remove-context-id'), 'context chips must be removable')
assert(extension.includes('onDidDeleteFiles'), 'attached file context must be watched for stale deletion')
assert(extension.includes('contextAttachments'), 'agent request must advertise context attachment capabilities')
assert(extension.includes("type ChatMode = 'ask' | 'edit' | 'agent' | 'plan'"), 'extension must define real Ask/Edit/Agent/Plan modes')
assert(extension.includes('modeContract'), 'extension must define mode-specific contracts')
assert(extension.includes('buildModeInstruction'), 'extension must inject mode-specific prompt instructions')
assert(extension.includes('interactionMode: mode'), 'agent request must send the selected interaction mode')
assert(extension.includes('chatMode: mode'), 'agent request must send explicit chatMode')
assert(extension.includes('allowedActions'), 'mode contracts must constrain allowed IDE actions')
assert(extension.includes('actionAllowedInMode'), 'extension must block actions that violate the selected mode')
assert(extension.includes('handoffPlanToAgent'), 'Plan mode must support handoff to Agent mode')
assert(extension.includes('planHandoff'), 'action protocol must advertise Plan to Agent handoff support')
assert(extension.includes('modeChanged'), 'webview must support mode selection changes')
assert(extension.includes('<select id="mode"'), 'webview must expose a dedicated Ask/Edit/Agent/Plan mode picker')
assert(extension.includes("event.data.type === 'prefillPrompt' && typeof event.data.text === 'string'"), 'planner handoff must prefill the composer and switch mode')
assert(extension.includes('ideActionProtocol'), 'agent request must advertise the IDE action protocol')
assert(extension.includes("type RequestStatus = 'idle' | 'running' | 'stopping'"), 'extension must model running request status')
assert(extension.includes('activeAbortController'), 'extension must keep an abort controller for Stop')
assert(extension.includes('stopRequest'), 'extension must implement Stop for active requests')
assert(extension.includes('queuePrompt'), 'extension must queue follow-up prompts while running')
assert(extension.includes('steerRequest'), 'extension must capture steering notes while running')
assert(extension.includes('operationTimeline'), 'extension must maintain an operation timeline')
assert(extension.includes('DebugSnapshot'), 'extension must maintain a Chat Debug request payload snapshot')
assert(extension.includes('setDebugSnapshot'), 'extension must capture redacted bridge request payloads')
assert(extension.includes('agentOperations'), 'action protocol must advertise agent operation capabilities')
assert(extension.includes('subagents: { enabled: true, handoffOnly: true }'), 'agent operations must advertise subagent handoff capability')
assert(extension.includes("msg.type === 'stopRequest'"), 'webview must request active request cancellation')
assert(extension.includes("operation: 'steer'"), 'webview must send steering notes')
assert(extension.includes('renderTimeline'), 'webview must render operation timeline')
assert(extension.includes('renderDebugPayload'), 'webview must render Chat Debug payloads')
assert(extension.includes('id="opsPanel"'), 'webview must expose an agent operations panel')
assert(extension.includes('actions: contract.allowedActions'), 'action protocol must advertise mode-specific allowed actions')
assert(extension.includes('collectStreamActions'), 'extension must parse streamed IDE action events')
assert(extension.includes("data.type === 'ide-action'"), 'stream parser must accept ide-action events')
assert(extension.includes('runAction'), 'webview must be able to trigger action execution')
assert(extension.includes('executeIdeAction'), 'extension host must implement action execution')
assert(extension.includes('workspace.isTrusted'), 'edit/run actions must honor workspace trust')
assert(extension.includes('showWarningMessage'), 'runCommand actions must require explicit confirmation')
assert(extension.includes('createTerminal'), 'runCommand actions must execute through a VS Code terminal')
assert(extension.includes('writeTextFile'), 'edit actions must be able to write files')
assert(extension.includes('createActionReview'), 'edit actions must create review checkpoints before applying')
assert(extension.includes('previewActionReview'), 'edit actions must support diff preview before applying')
assert(extension.includes("executeCommand('vscode.diff'"), 'edit review must open VS Code diff previews')
assert(extension.includes('undoActionCheckpoint'), 'applied edit actions must support checkpoint undo')
assert(extension.includes('registerTextDocumentContentProvider'), 'diff previews must use a virtual review document provider')
assert(extension.includes('data-action-id'), 'webview must render executable action controls')
assert(extension.includes('data-preview-action-id'), 'webview must render diff preview controls')
assert(extension.includes('data-reject-action-id'), 'webview must render reject controls')
assert(extension.includes('data-undo-action-id'), 'webview must render checkpoint undo controls')
assert(/0\.0\.0-phase\.(6|7|8|9|10)/.test(manifest), 'extension manifest must report Phase 6 or later')
assert(manifest.includes('reviewed edit/run actions'), 'extension manifest must describe reviewed edit/run actions')
assert(manifest.includes('agent operation controls'), 'extension manifest must describe agent operation controls')
assert(manifest.includes('Chat Debug payloads'), 'extension manifest must describe Chat Debug payloads')
assert(manifest.includes('Ask/Edit/Agent/Plan mode contracts'), 'extension manifest must describe real mode contracts')
assert(manifest.includes('shogo.agentChat.openContextPicker'), 'extension manifest must contribute context picker command')
assert(manifest.includes('rich typed IDE context'), 'extension manifest must describe typed context attachments')

if (errors.length > 0) {
  console.error('Shogo Agent Chat Phase 5/6 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Shogo Agent Chat Phase 5/6 check passed.')
console.log('Rich IDE context and reviewed edit/run action handling are wired.')
