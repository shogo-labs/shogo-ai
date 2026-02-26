/**
 * Smart formatting utilities for dynamic app components.
 *
 * These functions auto-detect value types and format them for display,
 * ensuring canvases look polished regardless of what the agent provides.
 * All formatting is deterministic — no agent cooperation required.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/

/**
 * Detect if a string looks like an ISO date.
 */
export function isIsoDateString(val: unknown): val is string {
  return typeof val === 'string' && val.length >= 10 && ISO_DATE_RE.test(val)
}

/**
 * Format an ISO date string to a human-readable form.
 * "2026-02-26T10:00:00Z" → "Feb 26, 2026"
 * "2026-02-26" → "Feb 26, 2026"
 */
export function formatDate(val: string): string {
  try {
    const d = new Date(val)
    if (isNaN(d.getTime())) return val
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  } catch {
    return val
  }
}

/**
 * Format a number with commas for display.
 * 1234 → "1,234"
 * 1234.5 → "1,234.5"
 */
export function formatNumberWithCommas(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const parts = n.toString().split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

/**
 * Format a number in compact notation.
 * 1500000 → "1.5M"
 * 48000 → "48K"
 * 1234 → "1,234"
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (abs >= 100_000) return `${Math.round(n / 1_000)}K`
  return formatNumberWithCommas(n)
}

const PURE_NUMBER_RE = /^-?\d+(\.\d+)?$/

/**
 * Smart-format a metric value based on its unit.
 *
 * Only formats values that are actual numbers (typeof number) or pure
 * numeric strings ("42", "1234.5"). Pre-formatted strings like "18,200",
 * "$2.4M", "45 days", "87%" are displayed as-is to avoid lossy parsing.
 *
 * Returns { displayValue, displayUnit } so the component can render them.
 */
export function formatMetricValue(
  value: unknown,
  unit?: string,
): { displayValue: string; displayUnit: string } {
  if (value == null) return { displayValue: '—', displayUnit: '' }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (unit === '$') return { displayValue: `$${formatCompact(value)}`, displayUnit: '' }
    if (unit === '%') return { displayValue: `${value}%`, displayUnit: '' }
    return { displayValue: formatCompact(value), displayUnit: unit || '' }
  }

  const str = String(value)

  if (PURE_NUMBER_RE.test(str)) {
    const numVal = parseFloat(str)
    if (unit === '$') return { displayValue: `$${formatCompact(numVal)}`, displayUnit: '' }
    if (unit === '%') return { displayValue: `${numVal}%`, displayUnit: '' }
    return { displayValue: formatCompact(numVal), displayUnit: unit || '' }
  }

  return { displayValue: str, displayUnit: unit || '' }
}

/**
 * Infer trend direction from a trend value string.
 * "+12%" → "up"
 * "-3.5%" → "down"
 * "+$48 this week" → "up"
 * "-4.8%" → "down"
 * null/undefined → undefined (no trend)
 */
export function inferTrendDirection(trendValue?: string): 'up' | 'down' | 'neutral' | undefined {
  if (!trendValue) return undefined
  const trimmed = trendValue.trim()
  if (trimmed.startsWith('+')) return 'up'
  if (trimmed.startsWith('-')) return 'down'
  if (/^[\d$]/.test(trimmed)) return 'up'
  return undefined
}

/**
 * Auto-format a cell value for table display.
 * - ISO dates → "Feb 26, 2026"
 * - Numbers → "1,234" or "42.50" (with commas where appropriate)
 * - null/undefined → "—"
 */
export function formatCellValue(val: unknown): string {
  if (val == null) return '—'

  if (typeof val === 'number' && Number.isFinite(val)) {
    return formatNumberWithCommas(val)
  }

  const str = String(val)
  if (isIsoDateString(str)) return formatDate(str)

  return str
}

/**
 * Auto-format a text display value.
 * Detects ISO date strings and formats them.
 */
export function formatDisplayText(val: unknown): string {
  if (val == null) return ''
  const str = String(val)
  if (isIsoDateString(str)) return formatDate(str)
  return str
}
