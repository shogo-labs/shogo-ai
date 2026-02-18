/**
 * Thumbnail Service - Captures project preview screenshots using Playwright
 *
 * Provides fire-and-forget screenshot capture of project sandbox URLs.
 * Stores thumbnails in S3 (or disk fallback for local dev without S3).
 *
 * Usage:
 *   import { captureProjectThumbnail } from './services/thumbnail.service'
 *   captureProjectThumbnail(projectId, sandboxUrl) // fire-and-forget
 */

import { existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { prisma } from '../lib/prisma'
import { getS3Client } from '../lib/s3'
import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

// Thumbnail storage: S3 (production) or disk (local dev fallback)
const PROJECT_ROOT = resolve(import.meta.dir, '../../../../')
const THUMBNAILS_DIR = process.env.THUMBNAILS_DIR || resolve(PROJECT_ROOT, '_thumbnails')

// S3 configuration
const S3_THUMBNAILS_BUCKET = process.env.S3_WORKSPACES_BUCKET || process.env.S3_THUMBNAILS_BUCKET
const S3_THUMBNAILS_PREFIX = 'thumbnails/'

// Ensure thumbnails directory exists (for disk fallback)
if (!existsSync(THUMBNAILS_DIR)) {
  mkdirSync(THUMBNAILS_DIR, { recursive: true })
}

/**
 * Check if S3 storage is available for thumbnails
 */
function isS3Available(): boolean {
  return !!S3_THUMBNAILS_BUCKET
}

// Track in-progress captures to avoid duplicates
const capturesInProgress = new Set<string>()

// Cooldown: don't re-capture within 30 seconds
const CAPTURE_COOLDOWN_MS = 30_000
const lastCaptureTime = new Map<string, number>()

/**
 * Get the S3 key for a project's thumbnail
 */
function getThumbnailS3Key(projectId: string): string {
  return `${S3_THUMBNAILS_PREFIX}${projectId}.png`
}

/**
 * Get the file path for a project's thumbnail (disk fallback)
 */
function getThumbnailPath(projectId: string): string {
  return join(THUMBNAILS_DIR, `${projectId}.png`)
}

/**
 * Get the S3 key for a project's thumbnail (if stored in S3)
 * Returns null if not in S3 or S3 is not available
 */
export function getThumbnailKey(projectId: string): string | null {
  if (isS3Available()) {
    return getThumbnailS3Key(projectId)
  }
  return null
}

/**
 * Check if a thumbnail exists (S3 or disk)
 */
export async function thumbnailExists(projectId: string): Promise<boolean> {
  if (isS3Available()) {
    const key = getThumbnailS3Key(projectId)
    try {
      const client = getS3Client()
      await client.send(new HeadObjectCommand({
        Bucket: S3_THUMBNAILS_BUCKET!,
        Key: key,
      }))
      return true
    } catch (error: any) {
      if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
        return false
      }
      throw error
    }
  }
  return existsSync(getThumbnailPath(projectId))
}

/**
 * Capture a screenshot of a project's preview and save it as a thumbnail.
 * 
 * This is designed to be called fire-and-forget. It will:
 * 1. Skip if a capture is already in progress for this project
 * 2. Skip if the last capture was within the cooldown period
 * 3. Launch Playwright, navigate to the sandbox URL, take screenshot
 * 4. Save to _thumbnails/{projectId}.png
 * 5. Update the project's thumbnailKey and thumbnailUpdatedAt in the DB
 * 
 * @param projectId - The project ID
 * @param sandboxUrl - The sandbox URL to screenshot (must be accessible from the server)
 */
export async function captureProjectThumbnail(
  projectId: string,
  sandboxUrl: string,
): Promise<void> {
  // Skip if already capturing this project
  if (capturesInProgress.has(projectId)) {
    console.log(`[Thumbnail] Skipping capture for ${projectId} - already in progress`)
    return
  }

  // Skip if captured recently (cooldown)
  const lastCapture = lastCaptureTime.get(projectId)
  if (lastCapture && Date.now() - lastCapture < CAPTURE_COOLDOWN_MS) {
    console.log(`[Thumbnail] Skipping capture for ${projectId} - cooldown active`)
    return
  }

  capturesInProgress.add(projectId)

  try {
    console.log(`[Thumbnail] Capturing screenshot for project ${projectId} from ${sandboxUrl}`)

    // Dynamic import of Playwright (heavy dependency, only load when needed)
    const { chromium } = await import('playwright')

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      })

      // Navigate to sandbox URL with timeout
      await page.goto(sandboxUrl, {
        waitUntil: 'networkidle',
        timeout: 30_000,
      })

      // Wait a bit for any animations/transitions to settle
      await page.waitForTimeout(2000)

      // Take screenshot (to buffer first)
      const screenshotBuffer = await page.screenshot({
        type: 'png',
      })

      await page.close()

      // Upload to S3 or save to disk
      let thumbnailKey: string | null = null
      if (isS3Available()) {
        const key = getThumbnailS3Key(projectId)
        const client = getS3Client()
        
        await client.send(new PutObjectCommand({
          Bucket: S3_THUMBNAILS_BUCKET!,
          Key: key,
          Body: screenshotBuffer,
          ContentType: 'image/png',
          CacheControl: 'public, max-age=3600', // 1 hour cache
        }))
        
        thumbnailKey = key
        console.log(`[Thumbnail] Screenshot uploaded to S3: ${S3_THUMBNAILS_BUCKET}/${key}`)
      } else {
        // Fallback to disk storage
        const outputPath = getThumbnailPath(projectId)
        await Bun.write(outputPath, screenshotBuffer)
        // For disk storage, we still store a key to indicate thumbnail exists
        // The backend route will handle serving from disk
        thumbnailKey = `${projectId}.png`
        console.log(`[Thumbnail] Screenshot saved to disk: ${outputPath}`)
      }

      // Update database
      try {
        await prisma.project.update({
          where: { id: projectId },
          data: {
            thumbnailKey,
            thumbnailUpdatedAt: new Date(),
          },
        })
        console.log(`[Thumbnail] DB updated for project ${projectId}`)
      } catch (dbError: any) {
        console.error(`[Thumbnail] DB update failed for ${projectId}:`, dbError.message)
      }

      // Update cooldown
      lastCaptureTime.set(projectId, Date.now())
    } finally {
      await browser.close()
    }
  } catch (error: any) {
    console.error(`[Thumbnail] Capture failed for ${projectId}:`, error.message)
  } finally {
    capturesInProgress.delete(projectId)
  }
}

/**
 * Schedule a thumbnail capture after a delay.
 * Useful for triggering after builds complete (wait for HMR to finish).
 * 
 * @param projectId - The project ID
 * @param sandboxUrl - The sandbox URL to screenshot
 * @param delayMs - Delay before capturing (default: 5000ms)
 */
export function scheduleThumbnailCapture(
  projectId: string,
  sandboxUrl: string,
  delayMs: number = 5000,
): void {
  setTimeout(() => {
    captureProjectThumbnail(projectId, sandboxUrl).catch((err) => {
      console.error(`[Thumbnail] Scheduled capture failed for ${projectId}:`, err.message)
    })
  }, delayMs)
}

/**
 * Get the thumbnails directory path (for static file serving - disk fallback only)
 */
export function getThumbnailsDir(): string {
  return THUMBNAILS_DIR
}

/**
 * Check if using S3 storage
 */
export function isUsingS3(): boolean {
  return isS3Available()
}

/**
 * Get the S3 bucket for thumbnails
 */
export function getThumbnailsBucket(): string | null {
  return S3_THUMBNAILS_BUCKET || null
}

