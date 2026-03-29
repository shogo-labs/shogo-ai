// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  md: "markdown",
  mdx: "mdx",
  graphql: "graphql",
  gql: "graphql",
  prisma: "prisma",
  dockerfile: "dockerfile",
  tf: "hcl",
  lua: "lua",
  r: "r",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  scala: "scala",
  clj: "clojure",
  vim: "viml",
  env: "dotenv",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
}

const LABEL_MAP: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  go: "Go",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  json: "JSON",
  jsonc: "JSONC",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  sql: "SQL",
  bash: "Shell",
  fish: "Fish",
  powershell: "PowerShell",
  markdown: "Markdown",
  mdx: "MDX",
  graphql: "GraphQL",
  prisma: "Prisma",
  dockerfile: "Docker",
  hcl: "HCL",
  lua: "Lua",
  r: "R",
  dart: "Dart",
  elixir: "Elixir",
  erlang: "Erlang",
  haskell: "Haskell",
  scala: "Scala",
  clojure: "Clojure",
  viml: "Vim",
  dotenv: "Env",
  ini: "INI",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
}

export function getLanguageFromPath(filePath: string): string {
  const basename = filePath.split("/").pop() || ""
  const lower = basename.toLowerCase()

  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "dockerfile"
  if (lower === "makefile" || lower === "gnumakefile") return "makefile"

  const ext = basename.includes(".") ? basename.split(".").pop()?.toLowerCase() : undefined
  if (ext && ext in EXT_TO_LANG) return EXT_TO_LANG[ext]
  return "text"
}

export function getLanguageLabel(filePath: string): string {
  const lang = getLanguageFromPath(filePath)
  return LABEL_MAP[lang] || lang.charAt(0).toUpperCase() + lang.slice(1)
}

export function getBasename(filePath: string): string {
  return filePath.split("/").pop() || filePath
}
