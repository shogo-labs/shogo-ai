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

assert(idePanel.includes('ShogoIdeReplacementGate'), 'IDEPanel must render the compact Shogo IDE launcher')
assert(idePanel.includes('getShogoIdeBridge'), 'IDEPanel must detect the desktop Shogo IDE bridge')
assert(idePanel.includes('<Workbench'), 'IDEPanel must keep Monaco Workbench as the default in-tab editor')
assert(idePanel.includes('hasShogoIdeBridge && visible'), 'IDEPanel must show the desktop-only Shogo IDE action over Monaco when available')
assert(idePanel.includes('workspaceResolved={desktopWorkspaceChecked}'), 'IDEPanel must keep the launch action aware of workspace resolution')
assert(!idePanel.includes('shogo.ide.legacyMonaco'), 'IDEPanel must not persist a legacy Monaco mode because Monaco is the default')
assert(!idePanel.includes('Return to Shogo IDE'), 'IDEPanel must not show the old large replacement-gate return banner')
assert(!idePanel.includes('<ShogoIdePhase2Launcher'), 'IDEPanel must no longer render the Phase 2 overlay as the default desktop path')

assert(replacementGate.includes('export function getShogoIdeBridge'), 'compact launcher must export bridge detection')
assert(replacementGate.includes('window as unknown as { shogoDesktop?: { shogoIde?'), 'compact launcher must use the Electron preload bridge')
assert(replacementGate.includes('Open Shogo IDE'), 'compact launcher must expose Open Shogo IDE action')
assert(replacementGate.includes('workspaceResolved === false'), 'compact launcher must guard unresolved project folders')
assert(!replacementGate.includes("void launch('auto')"), 'compact launcher must not auto-launch Shogo IDE from the IDE tab')
assert(!replacementGate.includes('Use Legacy Monaco IDE'), 'compact launcher must not expose Monaco as legacy because Monaco is the default')
assert(!replacementGate.includes('Next setup command'), 'compact launcher must not show manual setup commands')

assert(desktopBridge.includes("ipcMain.handle('shogo-ide:launch'"), 'desktop bridge launch IPC must remain wired')
assert(desktopBridge.includes('launchReady'), 'desktop bridge must keep launch readiness status')
assert(phase2Check.includes('ShogoIdeReplacementGate'), 'Phase 2 check must be updated for Phase 5 replacement gate')

assert(docs.includes('Monaco workbench first, Shogo IDE as an explicit launcher'), 'Phase 5 docs must state replacement posture')
assert(docs.includes('Behavior matrix'), 'Phase 5 docs must include behavior matrix')
assert(docs.includes('Desktop does not open Shogo IDE automatically from the IDE tab'), 'Phase 5 docs must state explicit Desktop launch behavior')

if (errors.length > 0) {
  console.error('Phase 5 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 5 check passed.')
console.log('Desktop IDE tab now defaults to Monaco with a compact Shogo IDE launcher.')
