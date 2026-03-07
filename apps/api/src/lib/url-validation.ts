/**
 * URL Validation Helpers
 *
 * Prevents SSRF by blocking requests to private/internal IP ranges,
 * cloud metadata endpoints, and non-HTTP protocols.
 */

const PRIVATE_IP_RANGES = [
  /^127\./,                        // loopback
  /^10\./,                         // class A private
  /^172\.(1[6-9]|2\d|3[01])\./,   // class B private
  /^192\.168\./,                   // class C private
  /^169\.254\./,                   // link-local / cloud metadata
  /^0\./,                          // current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
]

const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',
  'metadata.google',
]

/**
 * Validate a URL for safe outbound requests (anti-SSRF).
 * Returns null if safe, or an error message string if blocked.
 */
export function validateOutboundUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'Invalid URL format'
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Protocol "${parsed.protocol}" is not allowed`
  }

  const hostname = parsed.hostname.toLowerCase()

  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    return `Hostname "${hostname}" is not allowed`
  }

  // Block IPv6 loopback
  if (hostname === '[::1]' || hostname === '::1') {
    return 'IPv6 loopback is not allowed'
  }

  // Check if hostname is an IP address matching private ranges
  for (const range of PRIVATE_IP_RANGES) {
    if (range.test(hostname)) {
      return `Private IP address "${hostname}" is not allowed`
    }
  }

  return null
}
