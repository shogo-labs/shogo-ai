#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
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
const main = read('apps/desktop/src/main.ts')
const layout = read('apps/mobile/app/(app)/projects/[id]/_layout.tsx')
const topBar = read('apps/mobile/components/project/ProjectTopBar.tsx')
const button = read('apps/mobile/components/project/topbar/OpenInShogoIdeButton.tsx')
const preload = read('apps/desktop/src/preload.ts')
const desktopBridge = read('apps/desktop/src/shogo-ide.ts')
const phase2Check = read('apps/shogo-ide/scripts/phase2-check.mjs')

assert(idePanel.includes('<Workbench'), 'IDEPanel must keep Monaco Workbench as the default in-tab editor')
assert(main.includes("label: 'Open Shogo IDE'"), 'File menu must expose Open Shogo IDE')
assert(!idePanel.includes('ShogoIdeReplacementGate'), 'IDEPanel must not use the removed replacement gate')
assert(!idePanel.includes('<ShogoIdePhase2Launcher'), 'IDEPanel must no longer render the Phase 2 overlay')
assert(!idePanel.includes('shogo.ide.legacyMonaco'), 'IDEPanel must not persist a legacy Monaco mode because Monaco is the default')
assert(!idePanel.includes('Return to Shogo IDE'), 'IDEPanel must not show the old large replacement-gate return banner')

assert(layout.includes('handleOpenCodeWorkbench'), 'project layout must own the managed workbench open/focus callback')
assert(layout.includes('getCodeWorkbenchBridge') && layout.includes('workspacePath'), 'project layout must call the desktop codeWorkbench bridge with workspace path support')
assert(layout.includes('codeWorkbenchStatus'), 'project layout must pass open progress to the top bar')
assert(topBar.includes('<OpenInShogoIdeButton'), 'the IDE tab top bar must offer Open in Shogo IDE')
assert(button.includes('codeWorkbenchButtonLabel') && button.includes('disabled={busy}'), 'the button must show progress and be disabled while opening')
assert(preload.includes("ipcRenderer.invoke('code-workbench:open'"), 'preload must expose managed workbench open IPC')
assert(!desktopBridge.includes("ipcMain.handle('shogo-ide:launch'"), 'legacy explicit launch IPC must be removed')
assert(!preload.includes('shogoIde: shogoIdeBridge'), 'preload must not expose the old shogoIde bridge')
assert(phase2Check.includes('codeWorkbench'), 'Phase 2 check must be updated for the managed workbench bridge')

if (errors.length > 0) {
  console.error('Phase 5 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 5 check passed.')
console.log('Desktop IDE tab keeps Monaco visible; its top bar opens/focuses the managed Shogo-IDE window and shows progress.')
