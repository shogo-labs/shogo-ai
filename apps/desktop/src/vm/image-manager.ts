// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'

const GITHUB_REPO = 'shogo-labs/shogo-ai'
const VM_IMAGE_TAG = 'vm-images-v1'

export const VM_IMAGE_VERSION = '1'

export interface DownloadProgress {
  bytesDownloaded: number
  totalBytes: number
  percent: number
  stage: 'downloading' | 'extracting'
}

export type ProgressCallback = (progress: DownloadProgress) => void

/**
 * Manages VM image lifecycle:
 *   - First-use download instead of bundling ~1.4 GB in installer
 *   - Version checks for updates
 *   - Cleanup on failure
 */
export class VMImageManager {
  constructor(private imageDir: string) {}

  isImagePresent(): boolean {
    return (
      fs.existsSync(path.join(this.imageDir, 'vmlinuz')) &&
      fs.existsSync(path.join(this.imageDir, 'initrd.img')) &&
      fs.existsSync(path.join(this.imageDir, 'rootfs.qcow2'))
    )
  }

  getImageVersion(): string | null {
    const versionFile = path.join(this.imageDir, 'version.txt')
    if (!fs.existsSync(versionFile)) return null
    return fs.readFileSync(versionFile, 'utf-8').trim()
  }

  getDownloadUrl(): string {
    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    return `https://github.com/${GITHUB_REPO}/releases/download/${VM_IMAGE_TAG}/vm-image-${arch}.tar.gz`
  }

  getVersionUrl(): string {
    return `https://github.com/${GITHUB_REPO}/releases/download/${VM_IMAGE_TAG}/version.txt`
  }

  /**
   * Download VM image from GitHub Releases.
   * The archive should be a .tar.gz containing vmlinuz, initrd.img, rootfs.qcow2, version.txt.
   */
  async downloadImage(onProgress?: ProgressCallback): Promise<void> {
    fs.mkdirSync(this.imageDir, { recursive: true })

    const tarPath = path.join(this.imageDir, 'vm-image.tar.gz')
    const url = this.getDownloadUrl()

    try {
      await this.downloadFile(url, tarPath, onProgress)

      onProgress?.({ bytesDownloaded: 0, totalBytes: 0, percent: 100, stage: 'extracting' })

      const { execSync } = require('child_process')
      execSync(`tar xzf "${tarPath}" -C "${this.imageDir}"`, {
        stdio: 'pipe',
        timeout: 300000,
      })
    } catch (err) {
      this.cleanupPartial(tarPath)
      throw err
    }

    try { fs.unlinkSync(tarPath) } catch { /* ignore */ }

    if (!this.isImagePresent()) {
      this.cleanupAll()
      throw new Error('Downloaded archive did not contain expected VM image files (vmlinuz, initrd.img, rootfs.qcow2)')
    }
  }

  /**
   * Check if an updated image is available (compares version strings).
   */
  async checkForUpdate(): Promise<{ available: boolean; version: string }> {
    try {
      const response = await fetch(this.getVersionUrl(), { signal: AbortSignal.timeout(5000) })
      if (!response.ok) return { available: false, version: '' }

      const remoteVersion = (await response.text()).trim()
      const localVersion = this.getImageVersion()

      return {
        available: remoteVersion !== localVersion,
        version: remoteVersion,
      }
    } catch {
      return { available: false, version: '' }
    }
  }

  resetOverlay(overlayPath: string): void {
    if (fs.existsSync(overlayPath)) {
      fs.unlinkSync(overlayPath)
    }
  }

  private cleanupPartial(tarPath: string): void {
    try { fs.unlinkSync(tarPath) } catch { /* ignore */ }
  }

  private cleanupAll(): void {
    for (const file of ['vmlinuz', 'initrd.img', 'rootfs.qcow2', 'version.txt', 'vm-image.tar.gz']) {
      try { fs.unlinkSync(path.join(this.imageDir, file)) } catch { /* ignore */ }
    }
  }

  private downloadFile(url: string, destPath: string, onProgress?: ProgressCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http
      mod.get(url, { headers: { 'User-Agent': 'shogo-desktop' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location
          if (!redirectUrl) { reject(new Error('Redirect with no location')); return }
          this.downloadFile(redirectUrl, destPath, onProgress).then(resolve, reject)
          return
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`))
          return
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10)
        let bytesDownloaded = 0

        const file = fs.createWriteStream(destPath)
        res.on('data', (chunk: Buffer) => {
          bytesDownloaded += chunk.length
          if (onProgress && totalBytes > 0) {
            onProgress({
              bytesDownloaded,
              totalBytes,
              percent: Math.round((bytesDownloaded / totalBytes) * 100),
              stage: 'downloading',
            })
          }
        })
        res.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
        file.on('error', (err) => {
          this.cleanupPartial(destPath)
          reject(err)
        })
      }).on('error', (err) => {
        this.cleanupPartial(destPath)
        reject(err)
      })
    })
  }
}
