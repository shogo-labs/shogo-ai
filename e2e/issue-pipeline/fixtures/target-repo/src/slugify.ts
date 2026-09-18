/**
 * Turns arbitrary text into a URL-safe slug: lowercase, hyphen-separated,
 * no leading/trailing hyphens, no repeated hyphens.
 *
 * PLANTED BUG (see ../ISSUE.md): trailing punctuation leaves a stray
 * trailing hyphen, e.g. slugify("Great Deal!") === "great-deal-" instead of
 * "great-deal". Fix belongs in this file; do not change the public
 * signature or the existing passing tests in slugify.test.ts.
 */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
}
