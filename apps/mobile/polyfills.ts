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

  // Always override EventSource on native. The built-in Hermes/Expo Go
  // EventSource doesn't support custom headers, which we need to send
  // auth cookies. Our implementation uses XMLHttpRequest for reliable
  // incremental streaming and fires onerror on stream end for reconnection.
  {
    class RNEventSource {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSED = 2
      url: string
      readyState = 0
      onopen: ((ev: any) => void) | null = null
      onmessage: ((ev: any) => void) | null = null
      onerror: ((ev: any) => void) | null = null
      private _xhr: XMLHttpRequest | null = null
      private _lastIdx = 0

      constructor(url: string, options?: { headers?: Record<string, string> }) {
        this.url = url
        this._open(options?.headers)
      }

      private _open(headers?: Record<string, string>) {
        const xhr = new XMLHttpRequest()
        this._xhr = xhr
        this._lastIdx = 0

        xhr.open('GET', this.url, true)
        xhr.setRequestHeader('Accept', 'text/event-stream')
        xhr.setRequestHeader('Cache-Control', 'no-cache')
        if (headers) {
          for (const [k, v] of Object.entries(headers)) {
            xhr.setRequestHeader(k, v)
          }
        }

        xhr.onreadystatechange = () => {
          if (this.readyState === RNEventSource.CLOSED) return

          if (
            (xhr.readyState === 3 || xhr.readyState === 4) &&
            xhr.status >= 200 &&
            xhr.status < 400
          ) {
            if (this.readyState === RNEventSource.CONNECTING) {
              this.readyState = RNEventSource.OPEN
              this.onopen?.({ type: 'open' })
            }
            this._parse(xhr.responseText || '')
          }

          if (xhr.readyState === 4) {
            this.readyState = RNEventSource.CLOSED
            this.onerror?.({ type: 'error' })
          }
        }

        xhr.onerror = () => {
          if (this.readyState === RNEventSource.CLOSED) return
          this.readyState = RNEventSource.CLOSED
          this.onerror?.({ type: 'error' })
        }

        xhr.send()
      }

      private _parse(text: string) {
        const unprocessed = text.substring(this._lastIdx)
        const boundary = unprocessed.lastIndexOf('\n\n')
        if (boundary === -1) return

        const chunk = unprocessed.substring(0, boundary)
        this._lastIdx += boundary + 2

        for (const block of chunk.split('\n\n')) {
          if (!block.trim()) continue
          let data = ''
          let eventType = 'message'
          for (const line of block.split('\n')) {
            if (line.startsWith('data: ')) data += line.slice(6)
            else if (line.startsWith('data:')) data += line.slice(5)
            else if (line.startsWith('event: ')) eventType = line.slice(7)
            else if (line.startsWith('event:')) eventType = line.slice(6)
          }
          if (data && eventType === 'message') {
            this.onmessage?.({ type: 'message', data, lastEventId: '' })
          }
        }
      }

      close() {
        this.readyState = RNEventSource.CLOSED
        if (this._xhr) {
          this._xhr.abort()
          this._xhr = null
        }
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
