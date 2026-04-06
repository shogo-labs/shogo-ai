// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'

interface DownloadProgress {
  bytesDownloaded: number
  totalBytes: number
  percent: number
}

type ProgressCallback = (progress: DownloadProgress) => void

/**
 * Manages VM image lifecycle:
 *   - First-use download instead of bundling ~500 MB in installer
 *   - Version checks for updates
 *   - Integrity verification
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

  /**
   * Download VM image from a URL (e.g., GitHub Releases or S3).
   * The archive should be a .tar.gz containing vmlinuz, initrd.img, rootfs.qcow2.
   */
  async downloadImage(url: string, onProgress?: ProgressCallback): Promise<void> {
    fs.mkdirSync(this.imageDir, { recursive: true })

    const tarPath = path.join(this.imageDir, 'vm-image.tar.gz')

    await this.downloadFile(url, tarPath, onProgress)

    // Extract
    const { execSync } = require('child_process')
    try {
      execSync(`tar xzf "${tarPath}" -C "${this.imageDir}"`, {
        stdio: 'pipe',
        timeout: 120000,
      })
    } finally {
      try { fs.unlinkSync(tarPath) } catch { /* ignore */ }
    }

    if (!this.isImagePresent()) {
      throw new Error('Downloaded archive did not contain expected VM image files')
    }
  }

  /**
   * Check if an updated image is available (compares version strings).
   */
  async checkForUpdate(versionUrl: string): Promise<{ available: boolean; version: string }> {
    try {
      const response = await fetch(versionUrl, { signal: AbortSignal.timeout(5000) })
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

  /**
   * Delete the overlay to reset to a clean VM state.
   */
  resetOverlay(overlayPath: string): void {
    if (fs.existsSync(overlayPath)) {
      fs.unlinkSync(overlayPath)
    }
  }

  private downloadFile(url: string, destPath: string, onProgress?: ProgressCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http
      mod.get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect
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
            })
          }
        })
        res.pipe(file)
        file.on('finish', () => { file.close(); resolve() })
        file.on('error', reject)
      }).on('error', reject)
    })
  }
}
