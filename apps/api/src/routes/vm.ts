// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * VM Management Routes (local mode only)
 *
 * HTTP equivalents of the Electron IPC handlers in apps/desktop/src/main.ts.
 * These allow the browser-based dev UI to manage VM images, status, and config
 * without Electron.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import path from 'path'
import fs from 'fs'
import os from 'os'

// ---------------------------------------------------------------------------
// Config persistence (mirrors apps/desktop/src/config.ts without Electron)
// ---------------------------------------------------------------------------

interface VMIsolationConfig {
  enabled: boolean | 'auto'
  memoryMB: number
  cpus: number
}

interface DesktopConfig {
  mode: 'local' | 'cloud'
  cloudUrl: string
  vmIsolation: VMIsolationConfig
}

const DEFAULT_VM_CONFIG: VMIsolationConfig = {
  enabled: 'auto',
  memoryMB: 1536,
  cpus: 0,
}

const DEFAULT_CONFIG: DesktopConfig = {
  mode: 'local',
  cloudUrl: 'https://studio.shogo.ai',
  vmIsolation: { ...DEFAULT_VM_CONFIG },
}

function getUserDataDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Shogo')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Shogo')
  }
  return path.join(os.homedir(), '.config', 'shogo')
}

function getConfigPath(): string {
  return path.join(getUserDataDir(), 'config.json')
}

function readConfig(): DesktopConfig {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      mode: parsed.mode === 'cloud' ? 'cloud' : 'local',
      cloudUrl: typeof parsed.cloudUrl === 'string' && parsed.cloudUrl
        ? parsed.cloudUrl
        : DEFAULT_CONFIG.cloudUrl,
      vmIsolation: {
        ...DEFAULT_VM_CONFIG,
        ...(typeof parsed.vmIsolation === 'object' && parsed.vmIsolation !== null
          ? parsed.vmIsolation
          : {}),
      },
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

function writeConfig(config: Partial<DesktopConfig>): DesktopConfig {
  const current = readConfig()
  const merged: DesktopConfig = { ...current, ...config }
  const dir = path.dirname(getConfigPath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(getConfigPath(), JSON.stringify(merged, null, 2))
  return merged
}

// ---------------------------------------------------------------------------
// VM image / availability helpers
// ---------------------------------------------------------------------------

function getVMImageDir(): string {
  if (process.env.SHOGO_VM_IMAGE_DIR) return process.env.SHOGO_VM_IMAGE_DIR
  return path.resolve(__dirname, '../../../desktop/resources/vm')
}

function isQemuAvailable(): boolean {
  const imageDir = getVMImageDir()
  const bundled = path.join(imageDir, 'qemu-system-x86_64.exe')
  if (fs.existsSync(bundled)) return true
  const systemPath = 'C:\\Program Files\\qemu\\qemu-system-x86_64.exe'
  if (fs.existsSync(systemPath)) return true
  try {
    const { execSync } = require('child_process')
    const found = execSync('where qemu-system-x86_64', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    return !!found
  } catch { return false }
}

function isGoHelperAvailable(): boolean {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const binaryName = `shogo-vm-${arch}`
  const desktopRoot = path.resolve(__dirname, '../../../desktop')
  return fs.existsSync(path.join(desktopRoot, 'native', 'shogo-vm', binaryName))
}

function checkVMAvailable(): boolean {
  const imageDir = getVMImageDir()
  const hasKernel = fs.existsSync(path.join(imageDir, 'vmlinuz'))
  const hasRootfs = fs.existsSync(path.join(imageDir, 'rootfs-provisioned.qcow2')) || fs.existsSync(path.join(imageDir, 'rootfs.qcow2')) || fs.existsSync(path.join(imageDir, 'rootfs.raw'))
  if (!hasKernel || !hasRootfs) return false
  if (process.platform === 'darwin') return isGoHelperAvailable()
  if (process.platform === 'win32') return isQemuAvailable()
  return false
}

function checkImagesPresent(): boolean {
  const imageDir = getVMImageDir()
  return (
    fs.existsSync(path.join(imageDir, 'vmlinuz')) &&
    fs.existsSync(path.join(imageDir, 'initrd.img')) &&
    (fs.existsSync(path.join(imageDir, 'rootfs-provisioned.qcow2')) ||
      fs.existsSync(path.join(imageDir, 'rootfs.qcow2')))
  )
}

// ---------------------------------------------------------------------------
// Global VM image download state (shared across routes + auto-download)
// ---------------------------------------------------------------------------

export interface VMDownloadState {
  status: 'idle' | 'downloading' | 'extracting' | 'complete' | 'error'
  percent: number
  bytesDownloaded: number
  totalBytes: number
  error?: string
}

let vmDownloadState: VMDownloadState = {
  status: 'idle',
  percent: 0,
  bytesDownloaded: 0,
  totalBytes: 0,
}

export function getVMDownloadState(): VMDownloadState {
  return { ...vmDownloadState }
}

export async function triggerVMImageDownload(): Promise<void> {
  if (vmDownloadState.status === 'downloading' || vmDownloadState.status === 'extracting') {
    return
  }

  if (checkImagesPresent()) {
    vmDownloadState = { status: 'complete', percent: 100, bytesDownloaded: 0, totalBytes: 0 }
    return
  }

  vmDownloadState = { status: 'downloading', percent: 0, bytesDownloaded: 0, totalBytes: 0 }

  try {
    const vmModule = await import('../../../desktop/src/vm/index')
    const imageDir = getVMImageDir()
    const mgr = new vmModule.VMImageManager(imageDir)

    await mgr.downloadImage((progress) => {
      vmDownloadState = {
        status: progress.stage === 'extracting' ? 'extracting' : 'downloading',
        percent: progress.percent,
        bytesDownloaded: progress.bytesDownloaded,
        totalBytes: progress.totalBytes,
      }
    })

    vmDownloadState = { status: 'complete', percent: 100, bytesDownloaded: 0, totalBytes: 0 }
    console.log('[VM] Auto-download complete')
  } catch (err: any) {
    vmDownloadState = {
      status: 'error',
      percent: 0,
      bytesDownloaded: 0,
      totalBytes: 0,
      error: err?.message || 'Download failed',
    }
    console.error('[VM] Auto-download failed:', err?.message)
  }
}

function getImageVersion(): string | null {
  const versionFile = path.join(getVMImageDir(), 'version.txt')
  if (!fs.existsSync(versionFile)) return null
  return fs.readFileSync(versionFile, 'utf-8').trim()
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function vmRoutes(): Hono {
  const router = new Hono()

  /**
   * GET /status - combined VM status
   */
  router.get('/status', (c) => {
    const config = readConfig()
    return c.json({
      available: checkVMAvailable(),
      enabled: config.vmIsolation.enabled,
      memoryMB: config.vmIsolation.memoryMB,
      cpus: config.vmIsolation.cpus,
    })
  })

  /**
   * GET /images - VM image status
   */
  router.get('/images', (c) => {
    const imageDir = getVMImageDir()
    return c.json({
      imagesPresent: checkImagesPresent(),
      vmAvailable: checkVMAvailable(),
      imageVersion: getImageVersion(),
      imageDir,
    })
  })

  /**
   * POST /config - update VM configuration
   */
  router.post('/config', async (c) => {
    const body = await c.req.json<{ enabled?: boolean | 'auto'; memoryMB?: number; cpus?: number }>()
    const current = readConfig()
    const updated = writeConfig({
      vmIsolation: { ...current.vmIsolation, ...body },
    })
    return c.json(updated.vmIsolation)
  })

  /**
   * GET /images/download-status - poll current download state
   */
  router.get('/images/download-status', (c) => {
    return c.json(getVMDownloadState())
  })

  /**
   * POST /images/download - download VM images with SSE progress
   * Also kicks off the shared download state so the banner can poll.
   */
  router.post('/images/download', (c) => {
    return streamSSE(c, async (stream) => {
      try {
        const vmModule = await import('../../../desktop/src/vm/index')
        const imageDir = getVMImageDir()
        const mgr = new vmModule.VMImageManager(imageDir)

        vmDownloadState = { status: 'downloading', percent: 0, bytesDownloaded: 0, totalBytes: 0 }

        await mgr.downloadImage((progress) => {
          vmDownloadState = {
            status: progress.stage === 'extracting' ? 'extracting' : 'downloading',
            percent: progress.percent,
            bytesDownloaded: progress.bytesDownloaded,
            totalBytes: progress.totalBytes,
          }
          stream.writeSSE({
            event: 'progress',
            data: JSON.stringify(progress),
          })
        })

        vmDownloadState = { status: 'complete', percent: 100, bytesDownloaded: 0, totalBytes: 0 }

        await stream.writeSSE({
          event: 'complete',
          data: JSON.stringify({ success: true }),
        })
      } catch (err: any) {
        vmDownloadState = {
          status: 'error',
          percent: 0,
          bytesDownloaded: 0,
          totalBytes: 0,
          error: err?.message || 'Download failed',
        }
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ success: false, error: err?.message || 'Download failed' }),
        })
      }
    })
  })

  /**
   * GET /diagnostics - system information
   */
  router.get('/diagnostics', (c) => {
    const imageDir = getVMImageDir()
    const isWindows = process.platform === 'win32'
    const isMac = process.platform === 'darwin'
    return c.json({
      platform: process.platform,
      arch: process.arch,
      hypervisor: isWindows ? 'QEMU with WHPX' : isMac ? 'Apple Virtualization.framework' : 'Unknown',
      hypervisorFound: isWindows ? isQemuAvailable() : isMac ? isGoHelperAvailable() : false,
      executionMode: checkVMAvailable() ? 'VM Isolation' : 'Host Execution (fallback)',
      imageDir,
      logFile: isWindows
        ? path.join(process.env.APPDATA || '', 'Shogo', 'logs', 'main.log')
        : isMac
          ? path.join(os.homedir(), 'Library', 'Logs', 'Shogo', 'main.log')
          : '',
    })
  })

  return router
}
