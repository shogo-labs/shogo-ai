import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import type { LocalAgentRuntimeManager } from './runtime-manager'

let tray: Tray | null = null
let runtimeManager: LocalAgentRuntimeManager | null = null
let showWindowFn: (() => void) | null = null
let refreshInterval: ReturnType<typeof setInterval> | null = null

function buildTrayIcon(): Electron.NativeImage {
  // Use a simple 16x16 template image for macOS (renders in menu bar style)
  // On other platforms, use a regular icon
  try {
    const iconPath = join(__dirname, '../../resources/tray-icon.png')
    const image = nativeImage.createFromPath(iconPath)
    if (!image.isEmpty()) {
      if (process.platform === 'darwin') {
        image.setTemplateImage(true)
      }
      return image
    }
  } catch {
    // fall through to generated icon
  }

  // Fallback: generate a simple colored circle
  const size = 16
  const canvas = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <circle cx="8" cy="8" r="6" fill="#6366f1"/>
  </svg>`
  const image = nativeImage.createFromBuffer(Buffer.from(canvas))
  if (process.platform === 'darwin') {
    image.setTemplateImage(true)
  }
  return image
}

export function updateTrayMenu(): void {
  if (!tray || !runtimeManager) return

  const activeProjects = runtimeManager.getActiveProjects()
  const allRuntimes = runtimeManager.list()

  const agentItems: Electron.MenuItemConstructorOptions[] = allRuntimes.length > 0
    ? allRuntimes.map((rt) => ({
        label: `${rt.id.slice(0, 8)}... — ${rt.status}`,
        submenu: [
          {
            label: rt.status === 'running' ? 'Stop' : 'Start',
            click: () => {
              if (rt.status === 'running') {
                runtimeManager!.stop(rt.id).then(updateTrayMenu)
              } else {
                runtimeManager!.start(rt.id).then(updateTrayMenu)
              }
            },
          },
          {
            label: 'Restart',
            enabled: rt.status === 'running',
            click: () => {
              runtimeManager!.restart(rt.id).then(updateTrayMenu)
            },
          },
        ],
      }))
    : [{ label: 'No agents running', enabled: false }]

  const menu = Menu.buildFromTemplate([
    {
      label: `Shogo — ${activeProjects.length} agent${activeProjects.length !== 1 ? 's' : ''} running`,
      enabled: false,
    },
    { type: 'separator' },
    ...agentItems,
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => showWindowFn?.(),
    },
    {
      label: 'Stop All Agents',
      enabled: activeProjects.length > 0,
      click: async () => {
        await runtimeManager!.stopAll()
        updateTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Shogo',
      click: () => {
        runtimeManager!.stopAll().finally(() => {
          app.quit()
        })
      },
    },
  ])

  tray.setContextMenu(menu)

  const tooltip = activeProjects.length > 0
    ? `Shogo — ${activeProjects.length} agent${activeProjects.length !== 1 ? 's' : ''} running`
    : 'Shogo — No agents running'
  tray.setToolTip(tooltip)
}

export function createTray(
  manager: LocalAgentRuntimeManager,
  showWindow: () => void,
): void {
  runtimeManager = manager
  showWindowFn = showWindow

  tray = new Tray(buildTrayIcon())
  tray.on('click', () => showWindow())

  updateTrayMenu()

  // Periodically refresh the tray menu to reflect runtime status changes
  refreshInterval = setInterval(updateTrayMenu, 5000)
}

export function destroyTray(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval)
    refreshInterval = null
  }
  if (tray) {
    tray.destroy()
    tray = null
  }
}
