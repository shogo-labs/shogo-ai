// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Camera effects for huddles on web and desktop: background blur or a
 * replacement image, auto-framing (keeps your face centered), and low-light
 * adjustment. One LiveKit track processor runs the whole chain, because a
 * camera track takes a single processor:
 *
 *   camera -> [background segmentation] -> [framing + brightness canvas] -> published track
 *
 * Each stage is skipped when off, and with every effect off no processor is
 * attached at all. Native builds use `huddle-camera-effects.native.ts`, which
 * reports effects as unsupported.
 */
import { BackgroundProcessor, supportsBackgroundProcessors, type BackgroundProcessorWrapper } from '@livekit/track-processors'
import type { ProcessorOptions, Track, TrackProcessor } from 'livekit-client'
import type { BackgroundEffect } from './huddle-prefs'

export interface CameraEffectsConfig {
  background: BackgroundEffect
  autoFraming: boolean
  lowLight: boolean
}

export const cameraEffectsSupported = typeof document !== 'undefined' && supportsBackgroundProcessors()

export function hasCameraEffects(config: CameraEffectsConfig): boolean {
  return config.background.kind !== 'none' || config.autoFraming || config.lowLight
}

type VideoProcessorOptions = ProcessorOptions<Track.Kind.Video>

const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
const VISION_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm'

/** How much of the frame height the face should fill once framed, and the zoom limits. */
const FACE_FILL = 0.42
const MAX_ZOOM = 2
/** Per-frame easing toward the target crop, so the camera drifts instead of jumping. */
const EASE = 0.08
/** Average brightness (0..1) below which low-light adjustment kicks in, and the most it will lift. */
const DARK_LUMA = 0.42
const MAX_GAIN = 2.2

interface Crop {
  cx: number
  cy: number
  zoom: number
}

/**
 * The crop that puts a face (normalized 0..1 box) in the middle at a
 * comfortable size. Pure so it can be tested without a camera.
 */
export function targetCrop(face: { x: number; y: number; width: number; height: number } | null): Crop {
  if (!face) return { cx: 0.5, cy: 0.5, zoom: 1 }
  const zoom = Math.min(MAX_ZOOM, Math.max(1, FACE_FILL / Math.max(face.height, 0.05)))
  const half = 0.5 / zoom
  const cx = Math.min(1 - half, Math.max(half, face.x + face.width / 2))
  const cy = Math.min(1 - half, Math.max(half, face.y + face.height / 2))
  return { cx, cy, zoom }
}

/** The brightness multiplier for a frame of this average luminance (1 = leave alone). */
export function lowLightGain(luma: number): number {
  if (luma >= DARK_LUMA) return 1
  return Math.min(MAX_GAIN, DARK_LUMA / Math.max(luma, 0.05))
}

/**
 * The background as a raster image. The built-in gradients are SVG, and the
 * segmenter turns its background into a bitmap with `createImageBitmap`, which
 * browsers reject for SVG images. The failure is swallowed inside the library,
 * so the colour would silently never apply. Drawing it to a canvas first gives
 * every browser an ordinary PNG. Raster images (uploads) pass through as they are.
 */
export async function rasterizeBackground(url: string): Promise<string> {
  if (!url.startsWith('data:image/svg') && !/\.svg(\?|$)/i.test(url)) return url
  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Could not load the background image'))
    img.src = url
  })
  const width = img.naturalWidth || 1280
  const height = img.naturalHeight || 720
  const scale = Math.min(1, 1280 / width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not draw the background image')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

let faceDetectorPromise: Promise<any> | null = null

async function loadFaceDetector(): Promise<any> {
  if (!faceDetectorPromise) {
    faceDetectorPromise = (async () => {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(VISION_WASM)
      return FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
      })
    })().catch((err) => {
      faceDetectorPromise = null
      throw err
    })
  }
  return faceDetectorPromise
}

/** The processor to attach to the camera track for this configuration. */
export class CameraEffectsProcessor implements TrackProcessor<Track.Kind.Video, VideoProcessorOptions> {
  name = 'shogo-camera-effects'
  processedTrack?: MediaStreamTrack

  private opts?: VideoProcessorOptions
  private background?: BackgroundProcessorWrapper
  private video?: HTMLVideoElement
  private canvas?: HTMLCanvasElement
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private crop: Crop = { cx: 0.5, cy: 0.5, zoom: 1 }
  private gain = 1
  private lastDetect = 0
  private lastLuma = 0
  private face: { x: number; y: number; width: number; height: number } | null = null
  private detector: any = null
  /** Set when auto-framing couldn't start (model download failed); the rest keeps working. */
  onFramingUnavailable?: () => void

  constructor(private config: CameraEffectsConfig) {}

  async init(opts: VideoProcessorOptions): Promise<void> {
    this.opts = opts
    this.stopped = false
    await this.build()
  }

  async restart(opts: VideoProcessorOptions): Promise<void> {
    await this.teardown()
    await this.init(opts)
  }

  async destroy(): Promise<void> {
    await this.teardown()
  }

  private async build(): Promise<void> {
    const opts = this.opts!
    let source: MediaStreamTrack = opts.track
    const bg = this.config.background
    if (bg.kind !== 'none') {
      const imagePath = bg.kind === 'image' ? await rasterizeBackground(bg.url) : ''
      this.background =
        bg.kind === 'blur'
          ? BackgroundProcessor({ mode: 'background-blur', blurRadius: bg.radius })
          : BackgroundProcessor({ mode: 'virtual-background', imagePath })
      await this.background.init(opts)
      source = this.background.processedTrack ?? source
    }
    if (!this.config.autoFraming && !this.config.lowLight) {
      this.processedTrack = source
      return
    }

    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = new MediaStream([source])
    await video.play().catch(() => {})
    const settings = source.getSettings()
    const canvas = document.createElement('canvas')
    canvas.width = settings.width || video.videoWidth || 1280
    canvas.height = settings.height || video.videoHeight || 720
    this.video = video
    this.canvas = canvas
    this.processedTrack = canvas.captureStream(30).getVideoTracks()[0]

    if (this.config.autoFraming) {
      loadFaceDetector()
        .then((detector) => {
          this.detector = detector
        })
        .catch(() => this.onFramingUnavailable?.())
    }
    this.timer = setInterval(() => this.drawFrame(), 1000 / 30)
  }

  private drawFrame(): void {
    const { video, canvas } = this
    if (this.stopped || !video || !canvas || video.readyState < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const now = performance.now()

    if (this.config.autoFraming && this.detector && now - this.lastDetect > 200) {
      this.lastDetect = now
      try {
        const result = this.detector.detectForVideo(video, now)
        const box = result?.detections?.[0]?.boundingBox
        this.face = box
          ? { x: box.originX / video.videoWidth, y: box.originY / video.videoHeight, width: box.width / video.videoWidth, height: box.height / video.videoHeight }
          : null
      } catch {
        this.face = null
      }
    }
    if (this.config.autoFraming) {
      const target = targetCrop(this.face)
      this.crop = {
        cx: this.crop.cx + (target.cx - this.crop.cx) * EASE,
        cy: this.crop.cy + (target.cy - this.crop.cy) * EASE,
        zoom: this.crop.zoom + (target.zoom - this.crop.zoom) * EASE,
      }
    }

    if (this.config.lowLight && now - this.lastLuma > 500 && video.videoWidth) {
      this.lastLuma = now
      this.gain += (lowLightGain(this.sampleLuma(video)) - this.gain) * 0.5
    }

    const vw = video.videoWidth || canvas.width
    const vh = video.videoHeight || canvas.height
    const sw = vw / this.crop.zoom
    const sh = vh / this.crop.zoom
    const sx = Math.min(vw - sw, Math.max(0, this.crop.cx * vw - sw / 2))
    const sy = Math.min(vh - sh, Math.max(0, this.crop.cy * vh - sh / 2))
    if ('filter' in ctx) {
      ;(ctx as CanvasRenderingContext2D).filter = this.config.lowLight && this.gain > 1.02 ? `brightness(${this.gain.toFixed(2)}) contrast(${(1 + (this.gain - 1) * 0.12).toFixed(2)})` : 'none'
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  }

  /** Average luminance (0..1) of a tiny copy of the frame. */
  private sampleLuma(video: HTMLVideoElement): number {
    const probe = (this.probe ??= document.createElement('canvas'))
    probe.width = 32
    probe.height = 18
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (!ctx) return 1
    ctx.drawImage(video, 0, 0, 32, 18)
    const { data } = ctx.getImageData(0, 0, 32, 18)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    return sum / (data.length / 4) / 255
  }
  private probe?: HTMLCanvasElement

  private async teardown(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (this.canvas && this.processedTrack && this.processedTrack !== this.background?.processedTrack) this.processedTrack.stop()
    if (this.video) this.video.srcObject = null
    this.video = undefined
    this.canvas = undefined
    this.processedTrack = undefined
    await this.background?.destroy().catch(() => {})
    this.background = undefined
  }
}
