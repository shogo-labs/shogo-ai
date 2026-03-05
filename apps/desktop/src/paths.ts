import { app } from 'electron'
import path from 'path'
import fs from 'fs'

const IS_DEV = !app.isPackaged

export function getDataDir(): string {
  const dir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getDbPath(): string {
  return path.join(getDataDir(), 'shogo.db')
}

export function getWorkspacesDir(): string {
  const dir = path.join(getDataDir(), 'workspaces')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getBunPath(): string {
  const isWindows = process.platform === 'win32'
  const bunExe = isWindows ? 'bun.exe' : 'bun'

  if (IS_DEV) {
    const localBun = path.join(__dirname, '..', 'resources', 'bun', bunExe)
    if (fs.existsSync(localBun)) return localBun
    // Fall back to system bun in development
    return 'bun'
  }

  return path.join(process.resourcesPath!, 'bun', bunExe)
}

export function getApiDir(): string {
  if (IS_DEV) {
    return path.resolve(__dirname, '..', '..', 'api')
  }
  return path.join(process.resourcesPath!, 'api')
}

export function getWebDir(): string {
  if (IS_DEV) {
    return path.resolve(__dirname, '..', '..', 'mobile', 'dist')
  }
  return path.join(process.resourcesPath!, 'web')
}

export function getProjectRoot(): string {
  if (IS_DEV) {
    return path.resolve(__dirname, '..', '..', '..')
  }
  return path.join(process.resourcesPath!)
}
