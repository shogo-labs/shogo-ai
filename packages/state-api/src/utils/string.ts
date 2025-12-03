/**
 * String utility functions
 */

/**
 * Converts first character to lowercase.
 * Used for collection naming: "User" -> "user"
 *
 * @param str - String to convert
 * @returns String with lowercase first character
 */
export function camelCase(str: string): string {
  if (!str || str.length === 0) return str
  return str.charAt(0).toLowerCase() + str.slice(1)
}
