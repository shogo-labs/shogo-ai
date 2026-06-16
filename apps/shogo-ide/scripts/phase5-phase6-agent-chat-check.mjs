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
assert(extension.includes('ideActionProtocol'), 'agent request must advertise the IDE action protocol')
assert(extension.includes("actions: ['workspaceEdit', 'writeFile', 'runCommand', 'openFile']"), 'action protocol must advertise edit/run/open actions')
assert(extension.includes('collectStreamActions'), 'extension must parse streamed IDE action events')
assert(extension.includes("data.type === 'ide-action'"), 'stream parser must accept ide-action events')
assert(extension.includes('runAction'), 'webview must be able to trigger action execution')
assert(extension.includes('executeIdeAction'), 'extension host must implement action execution')
assert(extension.includes('workspace.isTrusted'), 'edit/run actions must honor workspace trust')
assert(extension.includes('showWarningMessage'), 'runCommand actions must require explicit confirmation')
assert(extension.includes('createTerminal'), 'runCommand actions must execute through a VS Code terminal')
assert(extension.includes('writeTextFile'), 'edit actions must be able to write files')
assert(extension.includes('data-action-id'), 'webview must render executable action controls')
assert(/0\.0\.0-phase\.(6|7|8)/.test(manifest), 'extension manifest must report Phase 6 or later')
assert(manifest.includes('confirmed edit/run actions'), 'extension manifest must describe confirmed edit/run actions')

if (errors.length > 0) {
  console.error('Shogo Agent Chat Phase 5/6 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Shogo Agent Chat Phase 5/6 check passed.')
console.log('Rich IDE context and confirmed edit/run action handling are wired.')
