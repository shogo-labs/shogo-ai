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
const main = read('apps/desktop/src/main.ts')
const preload = read('apps/desktop/src/preload.ts')
const idePanel = read('apps/mobile/components/project/panels/IDEPanel.tsx')
const layout = read('apps/mobile/app/(app)/projects/[id]/_layout.tsx')
const topBar = read('apps/mobile/components/project/ProjectTopBar.tsx')
const docs = read('apps/shogo-ide/PHASE_2_DESKTOP_INTEGRATION.md')

assert(desktopBridge.includes('getShogoIdeStatus'), 'desktop bridge must expose getShogoIdeStatus')
assert(desktopBridge.includes("ipcMain.handle('shogo-ide:get-status'"), 'desktop bridge must register status IPC')
assert(desktopBridge.includes("ipcMain.handle('shogo-ide:launch'"), 'desktop bridge must register launch IPC')
assert(desktopBridge.includes('SHOGO_IDE_EXECUTABLE'), 'desktop bridge must support executable override')
assert(desktopBridge.includes('SHOGO_REPO_ROOT'), 'desktop bridge must support repo-root override')
assert(desktopBridge.includes('spawn(actualLaunchPath'), 'desktop bridge must launch the resolved packaged executable or hardened source runner')
assert(desktopBridge.includes('resolveDevRunnerPath'), 'desktop bridge must support Code OSS source runner fallback')
assert(desktopBridge.includes('isCodeOssElectronRuntimeHealthy'), 'desktop bridge must validate and repair the Code OSS Electron runtime before launch')
assert(desktopBridge.includes('ensureShogoIdeRuntimeProfile'), 'desktop bridge must launch Code OSS with an isolated Shogo runtime profile')
assert(!desktopBridge.includes("'--disable-extensions'"), 'desktop bridge must not blanket-disable extensions because Shogo Agent Chat is bundled as an extension')
assert(desktopBridge.includes('--extensionDevelopmentPath'), 'desktop bridge must load bundled Shogo extensions in source-runner mode')
assert(desktopBridge.includes('shogo-agent-chat'), 'desktop bridge must load the Shogo Agent Chat extension in source-runner mode')
assert(desktopBridge.includes('SHOGO_IDE_DISABLED_UPSTREAM_EXTENSIONS'), 'desktop bridge must centralize disabled upstream Copilot/GitHub extension ids')
assert(desktopBridge.includes('GitHub.copilot-chat'), 'desktop bridge must disable upstream Copilot Chat for source-runner launches')
assert(desktopBridge.includes('vscode.github-authentication'), 'desktop bridge must disable upstream GitHub auth prompts for source-runner launches')
assert(desktopBridge.includes('chat.disableAIFeatures'), 'desktop bridge runtime settings must disable upstream built-in AI chat features')
assert(desktopBridge.includes('chat.titleBar.signIn.enabled'), 'desktop bridge runtime settings must disable upstream chat sign-in affordances')

assert(main.includes("from './shogo-ide'"), 'main.ts must import shogo-ide bridge')
assert(main.includes('registerShogoIdeIpcHandlers()'), 'main.ts must register shogo-ide IPC handlers')
assert(main.includes("ipcMain.handle('code-workbench:open'"), 'main.ts must register managed workbench open IPC')
assert(main.includes('openIdeWindow'), 'main.ts must open/focus the managed Shogo-IDE window')

assert(preload.includes('shogoIde: shogoIdeBridge'), 'preload must expose shogoIde status bridge')
assert(preload.includes("ipcRenderer.invoke('shogo-ide:get-status')"), 'preload must expose status IPC')
assert(preload.includes('codeWorkbench'), 'preload must expose managed Code-OSS workbench bridge')
assert(preload.includes("ipcRenderer.invoke('code-workbench:open'"), 'preload must expose managed workbench open IPC')

assert(idePanel.includes('<Workbench'), 'IDEPanel must keep Monaco Workbench as the default in-tab editor')
assert(idePanel.includes('Open Shogo IDE'), 'IDEPanel must expose the Open Shogo IDE focus/open action')
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
