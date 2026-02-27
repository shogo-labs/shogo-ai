/**
 * File attachment helpers — decode base64 data-URL file parts into text
 * so the agent LLM can see file content inline in the prompt.
 */

const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/csv',
  'application/sql',
  'application/x-sh',
  'application/xhtml+xml',
  'application/ld+json',
])

export function extractFilePartsAsText(
  parts: Array<{ type: string; mediaType?: string; url?: string; name?: string }>,
): string {
  const fileParts = parts.filter((p) => p.type === 'file' && p.url)
  if (fileParts.length === 0) return ''

  const sections: string[] = []
  for (const fp of fileParts) {
    const mediaType = fp.mediaType || 'application/octet-stream'
    const url = fp.url!
    const label = fp.name ? `${fp.name} (${mediaType})` : mediaType

    const isTextBased =
      mediaType.startsWith('text/') || TEXT_MEDIA_TYPES.has(mediaType)

    if (!url.startsWith('data:')) continue

    if (mediaType.startsWith('image/')) {
      sections.push(
        `[Attached Image (${label})]: An image was attached. Image content cannot be displayed as text.`,
      )
      continue
    }

    const base64Match = url.match(/^data:[^;]*;base64,(.+)$/)
    if (!base64Match) continue

    try {
      const decoded = Buffer.from(base64Match[1], 'base64').toString('utf-8')
      if (isTextBased || (!decoded.includes('\0') && decoded.length > 0)) {
        sections.push(
          `[Attached File (${label})]:\n${decoded}\n[End of Attached File]`,
        )
      } else {
        sections.push(
          `[Attached File (${label})]: Binary file attached (content cannot be displayed as text).`,
        )
      }
    } catch {
      sections.push(
        `[Attached File (${label})]: Could not decode file content.`,
      )
    }
  }

  return sections.join('\n\n')
}
