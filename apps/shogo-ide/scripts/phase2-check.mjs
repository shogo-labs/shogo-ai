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

const desktopBridge = read('apps/desktop/src/shogo-ide.ts')
const ideViews = read('apps/desktop/src/ide-views.ts')
const main = read('apps/desktop/src/main.ts')
const preload = read('apps/desktop/src/preload.ts')
const idePanel = read('apps/mobile/components/project/panels/IDEPanel.tsx')
const statusBar = read('apps/mobile/components/project/panels/ide/StatusBar.tsx')
const layout = read('apps/mobile/app/(app)/projects/[id]/_layout.tsx')
const topBar = read('apps/mobile/components/project/ProjectTopBar.tsx')
const docs = read('apps/shogo-ide/PHASE_2_DESKTOP_INTEGRATION.md')

assert(desktopBridge.includes('getShogoIdeStatus'), 'desktop bridge must expose getShogoIdeStatus')
assert(!desktopBridge.includes("ipcMain.handle('shogo-ide:launch'"), 'desktop bridge must not expose the old standalone Code - OSS launch IPC')
assert(!desktopBridge.includes('launchShogoIde'), 'desktop bridge must remove the old standalone launch function')
assert(!desktopBridge.includes('SHOGO_IDE_EXECUTABLE'), 'desktop bridge must not keep the old packaged executable override path')
assert(desktopBridge.includes('SHOGO_REPO_ROOT'), 'desktop bridge must support repo-root override')
assert(!desktopBridge.includes('spawn(actualLaunchPath'), 'desktop bridge must not launch native Code - OSS / Extension Development Host directly')
assert(!desktopBridge.includes('resolveDevRunnerPath'), 'desktop bridge must remove the old Code OSS source-runner fallback')
assert(!desktopBridge.includes('isCodeOssElectronRuntimeHealthy'), 'desktop bridge must not prepare the old Electron runtime launcher')
assert(desktopBridge.includes('ensureShogoIdeRuntimeProfile'), 'desktop bridge must still provide an isolated Shogo runtime profile for the managed web workbench')
assert(!ideViews.includes("'--disable-extensions'"), 'managed workbench must not blanket-disable extensions because shogo-core is bundled as an extension')
assert(ideViews.includes('--extensionDevelopmentPath'), 'managed workbench must load bundled Shogo extensions')
assert(ideViews.includes('shogo-core'), 'managed workbench must load the Shogo Core extension')
assert(ideViews.includes('SHOGO_IDE_DISABLED_UPSTREAM_EXTENSIONS'), 'managed workbench must centralize disabled upstream Copilot/GitHub extension ids')
assert(desktopBridge.includes('GitHub.copilot-chat'), 'desktop bridge must disable upstream Copilot Chat for source-runner launches')
assert(desktopBridge.includes('vscode.github-authentication'), 'desktop bridge must disable upstream GitHub auth prompts for source-runner launches')
assert(desktopBridge.includes('chat.disableAIFeatures'), 'desktop bridge runtime settings must disable upstream built-in AI chat features')
assert(desktopBridge.includes('chat.titleBar.signIn.enabled'), 'desktop bridge runtime settings must disable upstream chat sign-in affordances')

assert(!main.includes('registerShogoIdeIpcHandlers()'), 'main.ts must not register the old standalone Shogo IDE IPC handlers')
assert(main.includes("ipcMain.handle('code-workbench:open'"), 'main.ts must register managed workbench open IPC')
assert(main.includes('openIdeWindow'), 'main.ts must open/focus the managed Shogo-IDE window')
assert(main.includes("label: 'Open Shogo IDE'"), 'File menu must expose Open Shogo IDE')
assert(main.includes('openActiveCodeWorkbenchFromMenu'), 'File menu must use the managed workbench opener')

assert(!preload.includes('shogoIde: shogoIdeBridge'), 'preload must not expose the old shogoIde bridge')
assert(!preload.includes("ipcRenderer.invoke('shogo-ide:launch'"), 'preload must not expose the old standalone launch IPC')
assert(preload.includes('codeWorkbench'), 'preload must expose managed Code-OSS workbench bridge')
assert(preload.includes("ipcRenderer.invoke('code-workbench:open'"), 'preload must expose managed workbench open IPC')

assert(idePanel.includes('<Workbench'), 'IDEPanel must keep Monaco Workbench as the default in-tab editor')
assert(statusBar.includes('Shogo IDE'), 'StatusBar must expose the compact Shogo IDE focus/open action')
assert(layout.includes('handleOpenCodeWorkbench'), 'project layout must route IDE launches through the managed workbench opener')
assert(layout.includes('window.shogoDesktop?.codeWorkbench'), 'project layout must use the codeWorkbench bridge')
assert(topBar.includes("tabId === 'ide'"), 'top bar must special-case IDE tab presses')
assert(topBar.includes('onOpenCodeWorkbench?.()'), 'top bar must open/focus Shogo-IDE when IDE tab is pressed')

assert(docs.includes('keeps Monaco as the default Desktop IDE tab'), 'Phase 2 docs must state Monaco remains the default after Phase 5')
assert(docs.includes('after the user chooses **Open Shogo IDE**'), 'Phase 2 docs must state explicit desktop setup behavior')

if (errors.length > 0) {
  console.error('Phase 2 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 2 check passed.')
console.log('Desktop Shogo IDE bridge, managed workbench window, and Monaco IDE tab are wired safely.')
