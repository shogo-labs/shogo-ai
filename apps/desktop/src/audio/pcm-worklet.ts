// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AudioWorkletProcessor source for the renderer's capture pipeline.
 *
 * This file does NOT run as CommonJS inside the preload. Instead we export
 * the worklet body as a raw string so the renderer can spin it up via a
 * `Blob` URL handed to `audioWorklet.addModule(...)`. The processor lives
 * in the AudioWorkletGlobalScope — it has no access to `window`, `self`
 * is the worklet global, and only `registerProcessor`, `AudioWorkletProcessor`,
 * `sampleRate`, and `currentFrame` are in scope.
 *
 * Responsibilities:
 * - Accumulate Float32 audio frames from the upstream node's input until we
 *   have at least ~100 ms of audio (reduces message churn vs posting every
 *   128-frame chunk, which is the default AudioWorklet render quantum).
 * - Downmix multi-channel input to mono (simple average, good enough for
 *   meeting speech and consistent with Chromium's default stereo-to-mono).
 * - Convert Float32 [-1, 1] samples to Int16 LE in a transferable
 *   ArrayBuffer and post it back to the main thread with a timestamp.
 */

export const PCM_WORKLET_NAME = 'shogo-pcm-worklet'

export const PCM_WORKLET_SOURCE = `
class ShogoPcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const params = (options && options.processorOptions) || {}
    const batchMs = typeof params.batchMs === 'number' ? params.batchMs : 100
    this.batchFrames = Math.max(
      128,
      Math.floor(sampleRate * Math.max(16, batchMs) / 1000)
    )
    this.scratch = new Float32Array(this.batchFrames)
    this.fill = 0
    this.closed = false

    this.port.onmessage = (ev) => {
      if (ev && ev.data && ev.data.type === 'close') {
        this.closed = true
        this.flush()
      }
    }
  }

  flush() {
    if (this.fill === 0) return
    const out = new Int16Array(this.fill)
    for (let i = 0; i < this.fill; i++) {
      let s = this.scratch[i]
      if (s > 1) s = 1
      else if (s < -1) s = -1
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
    }
    const buf = out.buffer
    this.port.postMessage(
      { type: 'pcm', sampleRate, channels: 1, bitsPerSample: 16, frames: out.length, buffer: buf },
      [buf]
    )
    this.scratch = new Float32Array(this.batchFrames)
    this.fill = 0
  }

  process(inputs) {
    if (this.closed) return false
    const input = inputs[0]
    if (!input || input.length === 0) return true

    const frameCount = input[0].length
    const channels = input.length
    // Downmix to mono via average.
    for (let i = 0; i < frameCount; i++) {
      if (this.fill >= this.batchFrames) this.flush()
      let sum = 0
      for (let c = 0; c < channels; c++) sum += input[c][i]
      this.scratch[this.fill++] = sum / channels
    }
    if (this.fill >= this.batchFrames) this.flush()
    return true
  }
}

registerProcessor(${JSON.stringify(PCM_WORKLET_NAME)}, ShogoPcmProcessor)
`
