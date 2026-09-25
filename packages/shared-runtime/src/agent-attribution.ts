// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export const DEFAULT_SHOGO_AGENT_NAME = 'Shogo Agent'
export const DEFAULT_SHOGO_AGENT_EMAIL = 'agent@shogo.ai'
export const SHOGO_PR_FOOTER_MARKER = '<!-- made-with-shogo -->'

export function getShogoAgentName(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHOGO_AGENT_GIT_NAME || DEFAULT_SHOGO_AGENT_NAME
}

export function getShogoAgentEmail(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHOGO_AGENT_GIT_EMAIL || DEFAULT_SHOGO_AGENT_EMAIL
}

export function shogoCoAuthorTrailer(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `Co-authored-by: ${getShogoAgentName(env)} <${getShogoAgentEmail(env)}>`
}

/**
 * Add GitHub's standard co-author trailer to a git commit argument list.
 * The returned array is safe to pass to execFile/spawn because it does not
 * involve shell quoting.
 */
export function withShogoCommitTrailer(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (args[0] !== 'commit') return [...args]

  const trailer = shogoCoAuthorTrailer(env)
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--trailer' && args[index + 1] === trailer) {
      return [...args]
    }
  }
  return [...args, '--trailer', trailer]
}

export function shogoPrFooter(): string {
  return `${SHOGO_PR_FOOTER_MARKER}\nMade with [Shogo](https://shogo.ai)`
}

export function withShogoPrFooter(body: string | null | undefined): string {
  const normalized = body?.trimEnd() ?? ''
  if (normalized.includes(SHOGO_PR_FOOTER_MARKER)) return normalized
  return normalized ? `${normalized}\n\n---\n${shogoPrFooter()}` : shogoPrFooter()
}
