// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export type { VMManager, VMConfig, VMHandle } from './types'
export { VM_DEFAULTS } from './types'
export { VMPool } from './vm-pool'
export { VMImageManager } from './image-manager'
export { DarwinVMManager } from './darwin-vm-manager'
export { Win32VMManager } from './win32-vm-manager'

import path from 'path'
import fs from 'fs'
import type { VMManager } from './types'

/**
 * Create the platform-appropriate VM manager.
 *
 * macOS: DarwinVMManager (QEMU + HVF)
 * Windows: Win32VMManager (QEMU + WHPX)
 */
export function createVMManager(): VMManager {
  const vmImageDir = getVMImageDir()

  if (process.platform === 'darwin') {
    const { DarwinVMManager } = require('./darwin-vm-manager')
    return new DarwinVMManager(getDarwinQemuPath(), vmImageDir)
  }

  if (process.platform === 'win32') {
    const { Win32VMManager } = require('./win32-vm-manager')
    return new Win32VMManager(getQemuPath(), vmImageDir)
  }

  throw new Error(`VM isolation not supported on ${process.platform}`)
}

/**
 * Check whether VM isolation is available on this platform.
 */
export function isVMAvailable(): boolean {
  try {
    const vmImageDir = getVMImageDir()
    const hasKernel = fs.existsSync(path.join(vmImageDir, 'vmlinuz'))
    const hasRootfs = fs.existsSync(path.join(vmImageDir, 'rootfs-provisioned.qcow2')) || fs.existsSync(path.join(vmImageDir, 'rootfs.qcow2')) || fs.existsSync(path.join(vmImageDir, 'rootfs.raw'))

    if (!hasKernel || !hasRootfs) return false

    if (process.platform === 'darwin') {
      return fs.existsSync(getDarwinQemuPath())
    }

    if (process.platform === 'win32') {
      return fs.existsSync(getQemuPath())
    }

    return false
  } catch {
    return false
  }
}

function isElectron(): boolean {
  try {
    const e = require('electron')
    return e?.app != null
  } catch { return false }
}

// Resolve to `apps/desktop/` at runtime. Avoid `path.resolve(__dirname, ...)`
// here: this module gets bundled into the desktop's `dist/main.js` by
// `scripts/bundle-main.mjs`, and `bun build` inlines `__dirname` as a
// build-time absolute path string (e.g. `/Users/runner/work/.../src/vm`).
// `app.getAppPath()` is supplied by Electron at runtime and returns
// `apps/desktop/` in dev — exactly what `path.resolve(__dirname, '..', '..')`
// used to compute. Outside Electron (e.g. unit tests), allow callers to
// pin the directory via `SHOGO_DESKTOP_ROOT` and fall back to `process.cwd()`.
function getDesktopRoot(): string {
  if (isElectron()) {
    return require('electron').app.getAppPath()
  }
  return process.env.SHOGO_DESKTOP_ROOT || process.cwd()
}

export function getVMImageDir(): string {
  if (process.env.SHOGO_VM_IMAGE_DIR) return process.env.SHOGO_VM_IMAGE_DIR
  if (isElectron()) {
    const { app } = require('electron')
    if (!app.isPackaged) return path.join(getDesktopRoot(), 'resources', 'vm')
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    return path.join(app.getPath('userData'), 'vm-images', arch)
  }
  return path.join(getDesktopRoot(), 'resources', 'vm')
}

export function getGoHelperPath(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const binaryName = `shogo-vm-${arch}`

  if (process.env.SHOGO_VM_IMAGE_DIR) {
    return path.join(process.env.SHOGO_VM_IMAGE_DIR, binaryName)
  }
  if (isElectron()) {
    const { app } = require('electron')
    if (!app.isPackaged) return path.join(getDesktopRoot(), 'native', 'shogo-vm', binaryName)
    return path.join(process.resourcesPath!, 'vm-helper', binaryName)
  }
  return path.join(getDesktopRoot(), 'native', 'shogo-vm', binaryName)
}

export function getDarwinQemuPath(): string {
  if (isElectron()) {
    const { app } = require('electron')
    if (!app.isPackaged) return findDarwinQemuBinary()
    const bundled = path.join(process.resourcesPath!, 'vm', 'qemu-system-aarch64')
    if (fs.existsSync(bundled)) return bundled
    return findDarwinQemuBinary()
  }
  return findDarwinQemuBinary()
}

function findDarwinQemuBinary(): string {
  const bundled = path.join(getDesktopRoot(), 'resources', 'vm', 'qemu-system-aarch64')
  if (fs.existsSync(bundled)) return bundled
  const brewArm = '/opt/homebrew/bin/qemu-system-aarch64'
  if (fs.existsSync(brewArm)) return brewArm
  const brewIntel = '/usr/local/bin/qemu-system-aarch64'
  if (fs.existsSync(brewIntel)) return brewIntel
  try {
    const { execSync } = require('child_process')
    const found = execSync('which qemu-system-aarch64', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
    if (found && fs.existsSync(found)) return found
  } catch {}
  return bundled
}

function getQemuPath(): string {
  if (isElectron()) {
    const { app } = require('electron')
    if (!app.isPackaged) return findQemuBinary()
    const bundled = path.join(process.resourcesPath!, 'vm', 'qemu-system-x86_64.exe')
    if (fs.existsSync(bundled)) return bundled
  }
  return findQemuBinary()
}

function findQemuBinary(): string {
  const fs = require('fs')
  // 1. Bundled alongside VM images
  const bundled = path.join(getDesktopRoot(), 'resources', 'vm', 'qemu-system-x86_64.exe')
  if (fs.existsSync(bundled)) return bundled
  // 2. System-installed QEMU (standard winget/installer location)
  const systemPath = 'C:\\Program Files\\qemu\\qemu-system-x86_64.exe'
  if (fs.existsSync(systemPath)) return systemPath
  // 3. On PATH
  try {
    const { execSync } = require('child_process')
    const found = execSync('where qemu-system-x86_64', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0]
    if (found && fs.existsSync(found.trim())) return found.trim()
  } catch {}
  return bundled
}
