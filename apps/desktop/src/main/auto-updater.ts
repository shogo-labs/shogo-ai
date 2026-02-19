import pkg from 'electron-updater'
const { autoUpdater } = pkg
import { BrowserWindow, dialog } from 'electron'

export function setupAutoUpdater(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return

    dialog
      .showMessageBox(win, {
        type: 'info',
        title: 'Update Available',
        message: `Version ${info.version} is available. Download now?`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate()
        }
      })
  })

  autoUpdater.on('update-downloaded', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return

    dialog
      .showMessageBox(win, {
        type: 'info',
        title: 'Update Ready',
        message: 'Update downloaded. Restart to apply?',
        buttons: ['Restart', 'Later'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall()
        }
      })
  })

  autoUpdater.on('error', (err) => {
    console.error('[auto-updater] Error:', err.message)
  })

  // Check for updates after a short delay to avoid blocking startup
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.log('[auto-updater] Update check failed:', err.message)
    })
  }, 5000)
}
