// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import fs from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'

const GITHUB_REPO = 'shogo-labs/shogo-ai'
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}/releases`

export interface DownloadProgress {
  bytesDownloaded: number
  totalBytes: number
  percent: number
  stage: 'downloading' | 'extracting'
}

export type ProgressCallback = (progress: DownloadProgress) => void

interface ReleaseInfo {
  tag: string
  downloadUrl: string
  versionUrl: string
}

/**
 * Manages VM image lifecycle:
 *   - Discovers the latest vm-images release from GitHub at runtime
 *   - First-use download instead of bundling ~1.4 GB in installer
 *   - Version checks for updates
 *   - Cleanup on failure
 */
export class VMImageManager {
  private cachedRelease: ReleaseInfo | null = null

  constructor(private imageDir: string) {}

  isImagePresent(): boolean {
    return (
      fs.existsSync(path.join(this.imageDir, 'vmlinuz')) &&
      fs.existsSync(path.join(this.imageDir, 'initrd.img')) &&
      (fs.existsSync(path.join(this.imageDir, 'rootfs-provisioned.qcow2')) ||
        fs.existsSync(path.join(this.imageDir, 'rootfs.qcow2')))
    )
  }

  getImageVersion(): string | null {
    const versionFile = path.join(this.imageDir, 'version.txt')
    if (!fs.existsSync(versionFile)) return null
    return fs.readFileSync(versionFile, 'utf-8').trim()
  }

  /**
   * Query the GitHub Releases API for the latest vm-images-v* release.
   * Caches the result for the lifetime of this instance.
   */
  async discoverRelease(): Promise<ReleaseInfo> {
    if (this.cachedRelease) return this.cachedRelease

    const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
    const assetName = `vm-image-${arch}.tar.gz`

    const res = await fetch(GITHUB_API, {
      headers: {
        'User-Agent': 'shogo-desktop',
        'Accept': 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status} — cannot discover VM image release`)
    }

    const releases = await res.json() as Array<{
      tag_name: string
      draft: boolean
      prerelease: boolean
      assets: Array<{ name: string; browser_download_url: string }>
    }>

    const release = releases.find(
      (r) => r.tag_name.startsWith('vm-images-v') && !r.draft && !r.prerelease,
    )
    if (!release) {
      throw new Error('No VM image release found on GitHub')
    }

    const tarAsset = release.assets.find((a) => a.name === assetName)
    if (!tarAsset) {
      throw new Error(`No ${assetName} asset in release ${release.tag_name}`)
    }

    const versionAsset = release.assets.find((a) => a.name === 'version.txt')

    this.cachedRelease = {
      tag: release.tag_name,
      downloadUrl: tarAsset.browser_download_url,
      versionUrl: versionAsset?.browser_download_url ?? '',
    }
    return this.cachedRelease
  }

  /**
   * Download VM image from the latest GitHub Release.
   * The archive is a .tar.gz containing:
   *   vmlinuz, initrd.img, rootfs-provisioned.qcow2, version.txt
   */
  async downloadImage(onProgress?: ProgressCallback): Promise<void> {
    fs.mkdirSync(this.imageDir, { recursive: true })

    const { downloadUrl, tag } = await this.discoverRelease()
    console.log(`[VMImageManager] Downloading from ${tag}: ${downloadUrl}`)

    const tarPath = path.join(this.imageDir, 'vm-image.tar.gz')

    try {
      await this.downloadFile(downloadUrl, tarPath, onProgress)

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
      throw new Error('Downloaded archive did not contain expected VM image files')
    }
  }

  /**
   * Check if an updated image is available (compares version strings).
   */
  async checkForUpdate(): Promise<{ available: boolean; version: string }> {
    try {
      const { versionUrl } = await this.discoverRelease()
      if (!versionUrl) return { available: false, version: '' }

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

  resetOverlay(overlayPath: string): void {
    if (fs.existsSync(overlayPath)) {
      fs.unlinkSync(overlayPath)
    }
  }

  private cleanupPartial(tarPath: string): void {
    try { fs.unlinkSync(tarPath) } catch { /* ignore */ }
  }

  private cleanupAll(): void {
    for (const file of ['vmlinuz', 'initrd.img', 'rootfs-provisioned.qcow2', 'rootfs.qcow2', 'version.txt', 'vm-image.tar.gz']) {
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
