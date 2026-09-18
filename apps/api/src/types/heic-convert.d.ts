declare module 'heic-convert' {
  type HeicInput = ArrayBuffer | Uint8Array | Buffer

  type ConvertOptions = {
    buffer: HeicInput
    format: 'JPEG' | 'PNG'
    quality?: number
  }

  export default function convertHeic(options: ConvertOptions): Promise<Uint8Array>
}
