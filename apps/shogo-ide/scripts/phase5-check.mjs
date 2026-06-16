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

const idePanel = read('apps/mobile/components/project/panels/IDEPanel.tsx')
const replacementGate = read('apps/mobile/components/project/panels/ide/ShogoIdeReplacementGate.tsx')
const desktopBridge = read('apps/desktop/src/shogo-ide.ts')
const phase2Check = read('apps/shogo-ide/scripts/phase2-check.mjs')
const docs = read('apps/shogo-ide/PHASE_5_REPLACE_CUSTOM_IDE.md')

assert(idePanel.includes('ShogoIdeReplacementGate'), 'IDEPanel must import/render ShogoIdeReplacementGate')
assert(idePanel.includes('getShogoIdeBridge'), 'IDEPanel must detect the desktop Shogo IDE bridge')
assert(idePanel.includes('hasShogoIdeBridge && !legacyIdeOpen'), 'IDEPanel must default desktop bridge users to Shogo IDE gate')
assert(idePanel.includes('shogo.ide.legacyMonaco'), 'IDEPanel must persist explicit legacy Monaco choice')
assert(idePanel.includes('Return to Shogo IDE'), 'Legacy Monaco path must include return-to-Shogo escape hatch')
assert(idePanel.includes('<Workbench'), 'Legacy Monaco Workbench must remain available')
assert(!idePanel.includes('<ShogoIdePhase2Launcher'), 'IDEPanel must no longer render the Phase 2 overlay as the default desktop path')

assert(replacementGate.includes('export function getShogoIdeBridge'), 'replacement gate must export bridge detection')
assert(replacementGate.includes('window as unknown as { shogoDesktop?: { shogoIde?'), 'replacement gate must use the Electron preload bridge')
assert(replacementGate.includes('Open Shogo IDE'), 'replacement gate must expose Open Shogo IDE action')
assert(replacementGate.includes("void launch('auto')"), 'replacement gate must auto-launch Shogo IDE on Desktop')
assert(replacementGate.includes('Use Legacy Monaco IDE'), 'replacement gate must expose legacy fallback action')
assert(!replacementGate.includes('Next setup command'), 'replacement gate must not show manual setup commands')
assert(replacementGate.includes('Web and mobile keep using the existing Monaco path'), 'replacement gate must communicate Desktop-only behavior')

assert(desktopBridge.includes("ipcMain.handle('shogo-ide:launch'"), 'desktop bridge launch IPC must remain wired')
assert(desktopBridge.includes('launchReady'), 'desktop bridge must keep launch readiness status')
assert(phase2Check.includes('ShogoIdeReplacementGate'), 'Phase 2 check must be updated for Phase 5 replacement gate')

assert(docs.includes('Shogo IDE first, Monaco workbench as legacy fallback'), 'Phase 5 docs must state replacement posture')
assert(docs.includes('Behavior matrix'), 'Phase 5 docs must include behavior matrix')
assert(docs.includes('Desktop opens Shogo IDE automatically'), 'Phase 5 docs must state automatic Desktop launch behavior')

if (errors.length > 0) {
  console.error('Phase 5 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 5 check passed.')
console.log('Desktop IDE tab now defaults to Shogo IDE replacement gate with Legacy Monaco fallback.')
