// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Path -> Monaco language id, shared by every workspace backend (SdkFs,
// DesktopFs) and by the Workbench when a file is renamed, so a tab's syntax
// highlighting always follows its current name.

export const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.md': 'markdown', '.mdx': 'markdown',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html', '.htm': 'html',
  '.xml': 'xml', '.svg': 'xml',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.ini': 'ini',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.sql': 'sql',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.prisma': 'prisma', '.env': 'ini',
  '.dockerfile': 'dockerfile',
  '.lock': 'yaml',
}

export function extOf(p: string): string {
  const base = p.split('/').pop() ?? p
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot).toLowerCase() : ''
}

export function languageFor(path: string): string {
  const name = path.split('/').pop() ?? ''
  // `.env`, `.env.local`, `.env.production`, `.env.example` … are KEY=VALUE
  // files with `#` comments; Monaco's `ini` mode highlights those well.
  if (/^\.env(\.|$)/i.test(name)) return 'ini'
  const ext = extOf(path)
  if (ext) return LANG_BY_EXT[ext] ?? 'plaintext'
  if (/^dockerfile/i.test(name)) return 'dockerfile'
  if (/^makefile/i.test(name)) return 'makefile'
  return 'plaintext'
}
