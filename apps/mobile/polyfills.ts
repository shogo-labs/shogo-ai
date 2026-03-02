import { Platform } from 'react-native'
import structuredClone from '@ungap/structured-clone'

if (Platform.OS !== 'web') {
  // Polyfill crypto.randomUUID for Hermes (used by domain-stores for temp IDs)
  if (typeof crypto === 'undefined' || !crypto.randomUUID) {
    const g = global as any
    if (!g.crypto) g.crypto = {}
    if (!g.crypto.randomUUID) {
      g.crypto.randomUUID = (): string => {
        const bytes = new Uint8Array(16)
        for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
      }
    }
  }

  // Polyfill EventSource for Hermes (used by dynamic app streaming)
  // Extends the standard API with an optional `headers` property in the options
  // bag so callers can pass auth cookies on native where browser cookies aren't available.
  if (!('EventSource' in global)) {
    class RNEventSource {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 2
      url: string
      readyState = 0
      onopen: ((ev: any) => void) | null = null
      onmessage: ((ev: any) => void) | null = null
      onerror: ((ev: any) => void) | null = null
      private _controller: AbortController | null = null
      private _headers: Record<string, string> | undefined

      constructor(url: string, options?: { headers?: Record<string, string> }) {
        this.url = url
        this._headers = options?.headers
        this._connect()
      }

      private async _connect() {
        this._controller = new AbortController()
        try {
          const res = await fetch(this.url, {
            headers: { Accept: 'text/event-stream', ...this._headers },
            signal: this._controller.signal,
          })
          if (!res.ok || !res.body) {
            this.onerror?.({ type: 'error' })
            return
          }
          this.readyState = 1
          this.onopen?.({ type: 'open' })

          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buf = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += decoder.decode(value, { stream: true })
            const parts = buf.split('\n\n')
            buf = parts.pop() || ''
            for (const part of parts) {
              let data = ''
              let eventType = 'message'
              for (const line of part.split('\n')) {
                if (line.startsWith('data: ')) data += line.slice(6)
                else if (line.startsWith('data:')) data += line.slice(5)
                else if (line.startsWith('event: ')) eventType = line.slice(7)
              }
              if (data) {
                const evt = { type: eventType, data, lastEventId: '' }
                if (eventType === 'message') this.onmessage?.(evt)
              }
            }
          }
          this.readyState = 2
        } catch (e: any) {
          if (e?.name !== 'AbortError') {
            this.readyState = 2
            this.onerror?.({ type: 'error' })
          }
        }
      }

      close() {
        this.readyState = 2
        this._controller?.abort()
      }
    }
    ;(global as any).EventSource = RNEventSource
  }

  const setupPolyfills = async () => {
    const { polyfillGlobal } = await import(
      'react-native/Libraries/Utilities/PolyfillFunctions'
    )

    const { TextEncoderStream, TextDecoderStream } = await import(
      '@stardazed/streams-text-encoding'
    )

    if (!('structuredClone' in global)) {
      polyfillGlobal('structuredClone', () => structuredClone)
    }

    polyfillGlobal('TextEncoderStream', () => TextEncoderStream)
    polyfillGlobal('TextDecoderStream', () => TextDecoderStream)
  }

  setupPolyfills()
}

export {}
