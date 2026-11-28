// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Two packages publish a `shogo` bin: `@shogo-ai/sdk` and this worker. The
 * worker's default command is `chat`, so any bare word reaches the agent as a
 * prompt — including the SDK's own subcommand names. `bun x shogo generate`
 * from a folder with no project-local `.bin/shogo` used to resolve here and
 * start a paid one-shot agent turn whose prompt was the literal word
 * "generate" (SHO-616: 3,600+ such runs in agent checkouts and in the platform
 * repo, where the preview manager's codegen fallback called it).
 *
 * A single SDK subcommand name is never a prompt. Refuse it, and say what the
 * user probably meant, instead of billing them for the turn.
 */

/** Subcommands that belong to `@shogo-ai/sdk`'s `shogo` bin, not to `chat`. */
export const SDK_SUBCOMMANDS = ['generate', 'deploy', 'bucket', '3d'] as const

/** The message printed when an SDK subcommand arrives as a chat prompt. */
export function sdkSubcommandAsPromptMessage(word: string): string {
  const inProject = word === 'generate' ? ' In a Shogo project run `bun run generate`.' : ''
  return (
    `"shogo ${word}" is a @shogo-ai/sdk command, not a prompt.${inProject} ` +
    `To send it to the agent: shogo -p ${word}`
  )
}

/**
 * The refusal message when the default `chat` command was handed exactly one
 * positional that names an SDK subcommand, or `null` when the input is a real
 * prompt.
 *
 * `-p/--print` always wins: `shogo -p generate` is an explicit request to send
 * that word to the agent. Multi-word prompts (`shogo fix the bug`) are prompts.
 */
export function sdkSubcommandRedirect(
  promptParts: readonly string[],
  flags: { print?: string } = {},
): string | null {
  if (flags.print) return null
  if (promptParts.length !== 1) return null
  const word = promptParts[0]!.trim().toLowerCase()
  if (!(SDK_SUBCOMMANDS as readonly string[]).includes(word)) return null
  return sdkSubcommandAsPromptMessage(word)
}
