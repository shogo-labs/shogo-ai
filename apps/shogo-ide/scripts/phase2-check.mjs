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

const desktopBridge = read('apps/desktop/src/shogo-ide.ts')
const ideViews = read('apps/desktop/src/ide-views.ts')
const launch = read('apps/desktop/src/code-oss-server/launch.ts')
const install = read('apps/desktop/src/code-oss-server/install.ts')
const main = read('apps/desktop/src/main.ts')
const preload = read('apps/desktop/src/preload.ts')
const idePanel = read('apps/mobile/components/project/panels/IDEPanel.tsx')
const layout = read('apps/mobile/app/(app)/projects/[id]/_layout.tsx')
const topBar = read('apps/mobile/components/project/ProjectTopBar.tsx')
const desktopSources = [desktopBridge, ideViews, launch, install].join('\n')

assert(!desktopBridge.includes("ipcMain.handle('shogo-ide:launch'"), 'desktop bridge must not expose the old standalone Code - OSS launch IPC')
assert(!desktopBridge.includes('launchShogoIde'), 'desktop bridge must remove the old standalone launch function')
assert(!desktopBridge.includes('SHOGO_IDE_EXECUTABLE'), 'desktop bridge must not keep the old packaged executable override path')
assert(desktopBridge.includes('SHOGO_REPO_ROOT'), 'desktop bridge must support repo-root override')
assert(desktopBridge.includes('ensureShogoIdeRuntimeProfile'), 'desktop bridge must provide an isolated Shogo runtime profile for the managed web workbench')
assert(desktopBridge.includes('ensureShogoIdeServer'), 'desktop bridge must install the prebuilt server on first use')
assert(desktopBridge.includes('code-oss-server.manifest.json'), 'desktop bridge must read the shipped server manifest')
assert(desktopBridge.includes('chat.disableAIFeatures'), 'runtime settings must disable upstream built-in AI chat features')
assert(desktopBridge.includes('chat.titleBar.signIn.enabled'), 'runtime settings must disable upstream chat sign-in affordances')

// #1989: nothing may clone, build or npm-install Code - OSS on a user's machine.
for (const forbidden of ['git clone', "'clone'", 'npm install', "'install']", 'code-server.bat', 'code-server.sh', 'VSCODE_DEV: ', 'symlinkSync']) {
  assert(!desktopSources.includes(forbidden), `desktop Shogo IDE code must not contain ${forbidden}`)
}
assert(launch.includes("'out', 'server-main.js'"), 'the server must be launched as node out/server-main.js')
assert(launch.includes('SERVER_FLAG_ALLOWLIST'), 'server flags must come from the allowlist')
assert(launch.includes('--connection-token-file'), 'the server must be protected by a connection token file')
assert(!launch.includes('--extensionDevelopmentPath') && !launch.includes('--agents-'), 'flags the server ignores must not be passed')
assert(install.includes('sha256'), 'the downloaded server must be checksum-verified')

assert(!main.includes('registerShogoIdeIpcHandlers()'), 'main.ts must not register the old standalone Shogo IDE IPC handlers')
assert(main.includes("ipcMain.handle('code-workbench:open'"), 'main.ts must register managed workbench open IPC')
assert(main.includes("'code-workbench:status'"), 'main.ts must report open progress as code-workbench:status')
assert(main.includes("ipcMain.handle('code-workbench:open-log'"), 'main.ts must let the renderer open the Shogo IDE log')
assert(main.includes('openIdeWindow'), 'main.ts must open/focus the managed Shogo-IDE window')
assert(main.includes("label: 'Open Shogo IDE'"), 'File menu must expose Open Shogo IDE')
assert(main.includes('openActiveCodeWorkbenchFromMenu'), 'File menu must use the managed workbench opener')

assert(!preload.includes('shogoIde: shogoIdeBridge'), 'preload must not expose the old shogoIde bridge')
assert(!preload.includes("ipcRenderer.invoke('shogo-ide:launch'"), 'preload must not expose the old standalone launch IPC')
assert(preload.includes("ipcRenderer.invoke('code-workbench:open'"), 'preload must expose managed workbench open IPC')
assert(preload.includes("ipcRenderer.on('code-workbench:status'"), 'preload must expose open progress')

assert(idePanel.includes('<Workbench'), 'IDEPanel must keep Monaco Workbench as the default in-tab editor')
assert(layout.includes('handleOpenCodeWorkbench'), 'project layout must route IDE launches through the managed workbench opener')
assert(layout.includes('getCodeWorkbenchBridge') && layout.includes('workspacePath'), 'project layout must use the codeWorkbench bridge with workspace path support')
assert(layout.includes('alertCodeWorkbenchError'), 'project layout must surface Shogo IDE failures')
assert(topBar.includes('onOpenCodeWorkbench') && topBar.includes('OpenInShogoIdeButton'), 'top bar must expose Open in Shogo IDE with its progress')

if (errors.length > 0) {
  console.error('Phase 2 check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('Phase 2 check passed.')
console.log('Desktop Shogo IDE bridge, prebuilt server install, managed workbench window, and Monaco IDE tab are wired safely.')
