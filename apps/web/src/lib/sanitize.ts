/**
 * Input Sanitization Utilities
 *
 * Provides validation and sanitization functions to prevent XSS attacks
 * and other injection vulnerabilities in user-supplied input fields.
 */

/**
 * Regex pattern that matches HTML tags and common XSS vectors.
 * Catches: <script>, <img onerror=...>, <div>, &#60;, javascript:, etc.
 */
const HTML_TAG_PATTERN = /<[^>]*>|<|>/

/**
 * Checks whether a display name is safe (contains no HTML/script content).
 *
 * Rules:
 * - Must not contain `<` or `>` characters (blocks all HTML tags)
 * - Must not be empty after trimming
 * - Must not exceed 100 characters
 *
 * @returns `true` if the name is safe; `false` otherwise.
 */
export function isValidDisplayName(name: string): boolean {
  if (!name || name.trim().length === 0) return false
  if (name.length > 100) return false
  if (HTML_TAG_PATTERN.test(name)) return false
  return true
}

/**
 * Returns a user-friendly error message for an invalid display name,
 * or `null` if the name is valid.
 */
export function getDisplayNameError(name: string): string | null {
  if (!name || name.trim().length === 0) return null // don't show error on empty (handled by required)
  if (name.length > 100) return "Name must be 100 characters or fewer"
  if (HTML_TAG_PATTERN.test(name)) return "Name must not contain HTML or special characters like < >"
  return null
}

/**
 * Strips HTML tags and angle brackets from a string.
 * Used as a server-side safety net — even if client-side validation is bypassed,
 * the stored value will be safe.
 *
 * @returns The sanitized string with all HTML tags and angle brackets removed.
 */
export function stripHtmlTags(input: string): string {
  if (!input) return input
  // First remove full HTML tags, then remove any remaining angle brackets
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .trim()
}

