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
const statusBar = read('apps/mobile/components/project/panels/ide/StatusBar.tsx')
const main = read('apps/desktop/src/main.ts')
const layout = read('apps/mobile/app/(app)/projects/[id]/_layout.tsx')
const topBar = read('apps/mobile/components/project/ProjectTopBar.tsx')
const preload = read('apps/desktop/src/preload.ts')
const desktopBridge = read('apps/desktop/src/shogo-ide.ts')
const phase2Check = read('apps/shogo-ide/scripts/phase2-check.mjs')
const docs = read('apps/shogo-ide/PHASE_5_REPLACE_CUSTOM_IDE.md')

assert(idePanel.includes('<Workbench'), 'IDEPanel must keep Monaco Workbench as the default in-tab editor')
assert(statusBar.includes('Shogo IDE'), 'StatusBar must expose the compact Shogo IDE action')
assert(main.includes("label: 'Open Shogo IDE'"), 'File menu must expose Open Shogo IDE')
assert(idePanel.includes('onOpenCodeWorkbench'), 'IDEPanel must accept the managed workbench open/focus callback')
assert(!idePanel.includes('ShogoIdeReplacementGate'), 'IDEPanel must not use the removed replacement gate')
assert(!idePanel.includes('<ShogoIdePhase2Launcher'), 'IDEPanel must no longer render the Phase 2 overlay')
assert(!idePanel.includes('shogo.ide.legacyMonaco'), 'IDEPanel must not persist a legacy Monaco mode because Monaco is the default')
assert(!idePanel.includes('Return to Shogo IDE'), 'IDEPanel must not show the old large replacement-gate return banner')

assert(layout.includes('handleOpenCodeWorkbench'), 'project layout must own the managed workbench open/focus callback')
assert(layout.includes('shogoDesktop') && layout.includes('codeWorkbench') && layout.includes('workspacePath'), 'project layout must call the desktop codeWorkbench bridge with workspace path support')
assert(topBar.includes('onOpenCodeWorkbench?.()'), 'IDE tab press must open/focus Shogo-IDE')
assert(preload.includes("ipcRenderer.invoke('code-workbench:open'"), 'preload must expose managed workbench open IPC')
assert(!desktopBridge.includes("ipcMain.handle('shogo-ide:launch'"), 'legacy explicit launch IPC must be removed')
assert(!preload.includes('shogoIde: shogoIdeBridge'), 'preload must not expose the old shogoIde bridge')
assert(desktopBridge.includes('launchReady'), 'desktop bridge must keep launch readiness status')
assert(phase2Check.includes('codeWorkbench'), 'Phase 2 check must be updated for the managed workbench bridge')

assert(docs.includes('Monaco workbench first, Shogo IDE as an explicit launcher'), 'Phase 5 docs must state replacement posture')
assert(docs.includes('Behavior matrix'), 'Phase 5 docs must include behavior matrix')
assert(docs.includes('IDE tab now keeps Monaco visible and opens/focuses the managed Shogo-IDE window'), 'Phase 5 docs must state final Desktop launch behavior')

if (errors.length > 0) {
  console.error('Phase 5 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 5 check passed.')
console.log('Desktop IDE tab keeps Monaco visible and opens/focuses the managed Shogo-IDE window.')
